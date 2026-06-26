// Mocha API client.
//
// Ported from EquiMocha's Vencord native.ts. The biggest structural difference:
// native.ts ran in an Electron main-process helper with Node's fs/fetch-with-streaming-body,
// so it could read a file from disk in small chunks and stream each multipart part directly
// from a file handle. Revenge has no such helper — there is no Node runtime, no Electron,
// and no desktop "native" process to delegate to. Everything here runs in Discord's React
// Native JS thread, and the only way to get file bytes is RNFileModule.readFile(path, "base64"),
// which returns the *entire* file as one base64 string in memory.
//
// Practical consequence: every part is still uploaded with the same S3 multipart flow as
// before (so very large files are still fine on the server side), but the whole file has to
// fit in memory as a base64 string + decoded bytes simultaneously on the client first. There's
// no equivalent of native.ts's uploadMultipartFromPath, which read+uploaded one chunk at a time
// straight from disk without ever holding the full file in memory.

const MOCHA_BASE = "https://api.mocha.my";
const MOCHA_WEB = "https://mocha.my";

const DEFAULT_CHUNK_SIZE = 10 * 1024 * 1024;
const MIN_CHUNK_SIZE = 5 * 1024 * 1024;
const MAX_CHUNK_SIZE = 1000 * 1024 * 1024;
const HARD_MAX_PARTS = 10000;
const PART_RETRIES = 3;

export type ShareExpiry = "never" | "1d" | "7d" | "30d";

export type UploadPhase =
	| "idle"
	| "preparing"
	| "uploading"
	| "retrying"
	| "sharing"
	| "success"
	| "failed"
	| "cancelled";

export type UploadProgress = {
	phase: UploadPhase;
	percent: number;
	transferredBytes: number;
	totalBytes: number;
	partNumber: number;
	totalParts: number;
	status: string;
};

export type ChunkOptions = {
	chunkSizeMB?: number;
	maxChunks?: number;
};

export type UploadResult = {
	success: boolean;
	url?: string;
	error?: string;
};

function describeError(error: unknown): string {
	if (!(error instanceof Error)) return "Unknown error";
	const cause = (error as { cause?: unknown; }).cause;
	if (cause instanceof Error) return `${error.message}: ${cause.message}`;
	if (cause) return `${error.message}: ${String(cause)}`;
	return error.message;
}

function resolveChunkSize(fileSize: number, options?: ChunkOptions): number {
	const requestedBytes = options?.chunkSizeMB ? options.chunkSizeMB * 1024 * 1024 : DEFAULT_CHUNK_SIZE;
	const maxChunks = Math.min(HARD_MAX_PARTS, Math.max(1, options?.maxChunks ?? HARD_MAX_PARTS));

	let chunkSize = Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, Math.round(requestedBytes)));

	const minChunkSizeForCap = Math.ceil(fileSize / maxChunks);
	if (minChunkSizeForCap > chunkSize) {
		chunkSize = Math.min(MAX_CHUNK_SIZE, minChunkSizeForCap);
	}

	return chunkSize;
}

function today(): string {
	return formatLocalDate(0);
}

function formatLocalDate(offsetDays: number): string {
	const date = new Date();
	date.setDate(date.getDate() + offsetDays);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function getCandidateUploadFolders(): string[] {
	return [-1, 0, 1].map(offset => `/discord/${formatLocalDate(offset)}`);
}

function authHeaders(apiKey: string, extra: Record<string, string> = {}) {
	return {
		Authorization: `Bearer ${apiKey}`,
		...extra
	};
}

function expiryHours(value: ShareExpiry): number | null {
	const map: Record<string, number> = { "1d": 24, "7d": 168, "30d": 720 };
	return map[value] ?? null;
}

// Folder paths already confirmed to exist this session, to avoid re-issuing
// create-folder requests for every single upload.
const knownFolders = new Set<string>();

async function createFolderRequest(apiKey: string, parent: string, name: string): Promise<Response> {
	return fetch(`${MOCHA_BASE}/api/files/folders`, {
		method: "POST",
		headers: authHeaders(apiKey, { "Content-Type": "application/json" }),
		body: JSON.stringify({ path: parent, name })
	});
}

async function ensureFolder(apiKey: string, path: string) {
	const parts = path.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
	let cumulativePath = "";

	for (let i = 0; i < parts.length; i++) {
		const name = parts[i];
		cumulativePath += `/${name}`;
		if (knownFolders.has(cumulativePath)) continue;

		const parent = `/${parts.slice(0, i).join("/")}`.replace(/\/$/, "") || "/";
		let response = await createFolderRequest(apiKey, parent, name);

		if (response.status === 404 && parent === "/") {
			response = await createFolderRequest(apiKey, "", name);
		}

		if (!response.ok && response.status !== 409) {
			throw new Error(`Folder create failed: ${response.status} ${await response.text()}`);
		}

		knownFolders.add(cumulativePath);
	}
}

function getFileId(data: any): string {
	const fileId = data?.fileId ?? data?.id ?? data?.file?.id;
	if (!fileId) throw new Error("No file id returned from Mocha");
	return String(fileId);
}

function normalizeFileName(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeMimeType(value: unknown): string {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isGenericMimeType(value: string): boolean {
	return !value || value === "application/octet-stream";
}

function coerceSize(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
	}
	return null;
}

function getListedFileId(file: any): string {
	return String(file?.id ?? file?.fileId ?? file?.file_id ?? file?.uuid ?? "");
}
function getListedFileName(file: any): string {
	return String(file?.originalName ?? file?.original_name ?? file?.name ?? file?.fileName ?? file?.file_name ?? "");
}
function getListedFileSize(file: any): number | null {
	return coerceSize(file?.fileSize ?? file?.file_size ?? file?.size ?? file?.bytes);
}
function getListedFileMimeType(file: any): string {
	return String(file?.mimeType ?? file?.mime_type ?? file?.contentType ?? file?.content_type ?? "");
}

function listedFileMatches(file: any, filename: string, size: number, mimeType: string): boolean {
	const fileId = getListedFileId(file);
	if (!fileId) return false;

	const listedName = normalizeFileName(getListedFileName(file));
	if (listedName && listedName !== normalizeFileName(filename)) return false;

	const listedSize = getListedFileSize(file);
	if (listedSize !== size) return false;

	const listedMime = normalizeMimeType(getListedFileMimeType(file));
	const targetMime = normalizeMimeType(mimeType);
	if (listedMime && !isGenericMimeType(targetMime) && listedMime !== targetMime) return false;

	return Boolean(listedName);
}

async function listFilesInFolder(apiKey: string, folderPath: string): Promise<any[]> {
	const url = new URL(`${MOCHA_BASE}/api/files`);
	url.searchParams.set("path", folderPath);
	url.searchParams.set("includeSubfolders", "1");

	const response = await fetch(url.toString(), { method: "GET", headers: authHeaders(apiKey) });
	if (!response.ok) return [];

	const data = await response.json().catch(() => null);
	return Array.isArray(data?.files) ? data.files : [];
}

type ExistingMochaFile = { id: string; name: string; size: number; mimeType: string; };

async function findExistingMochaFile(apiKey: string, filename: string, size: number, mimeType: string): Promise<ExistingMochaFile | null> {
	for (const folder of getCandidateUploadFolders()) {
		const files = await listFilesInFolder(apiKey, folder).catch(() => []);
		const match = files.find(file => listedFileMatches(file, filename, size, mimeType));
		if (!match) continue;

		return {
			id: getListedFileId(match),
			name: getListedFileName(match),
			size: getListedFileSize(match) ?? size,
			mimeType: getListedFileMimeType(match) || mimeType
		};
	}
	return null;
}

function getShareToken(share: any): string {
	return String(share?.token ?? share?.shareToken ?? share?.id ?? "");
}
function getShareFileName(share: any): string {
	return String(share?.originalName ?? share?.original_name ?? share?.fileName ?? share?.file_name ?? share?.name ?? "");
}
function getShareSize(share: any): number | null {
	return coerceSize(share?.fileSize ?? share?.file_size ?? share?.size ?? share?.bytes);
}
function getShareMimeType(share: any): string {
	return String(share?.mimeType ?? share?.mime_type ?? share?.contentType ?? share?.content_type ?? "");
}
function isShareActive(share: any): boolean {
	return share?.is_active ?? share?.isActive ?? true;
}
function shareMatchesFile(share: any, filename: string, size: number, mimeType: string): boolean {
	const shareName = normalizeFileName(getShareFileName(share));
	if (shareName && shareName !== normalizeFileName(filename)) return false;

	const shareSize = getShareSize(share);
	if (shareSize !== null && shareSize !== size) return false;

	const shareMime = normalizeMimeType(getShareMimeType(share));
	const fileMime = normalizeMimeType(mimeType);
	if (shareMime && !isGenericMimeType(fileMime) && shareMime !== fileMime) return false;

	return Boolean(shareName) && shareSize === size;
}

type ExistingShareMatch = { url: string; token: string; };

async function findExistingShare(apiKey: string, filename: string, size: number, mimeType: string): Promise<ExistingShareMatch | null> {
	const sharesResponse = await fetch(`${MOCHA_BASE}/api/shares`, { method: "GET", headers: authHeaders(apiKey) });
	if (!sharesResponse.ok) return null;

	const sharesData = await sharesResponse.json();
	const shares = Array.isArray(sharesData) ? sharesData : sharesData?.shares;
	if (!Array.isArray(shares)) return null;

	const targetName = normalizeFileName(filename);
	const likelyShares = shares.filter((share: any) => {
		if (!isShareActive(share)) return false;
		if (!getShareToken(share)) return false;
		if (shareMatchesFile(share, filename, size, mimeType)) return true;

		const listedName = normalizeFileName(getShareFileName(share));
		const listedSize = getShareSize(share);
		return !listedName || listedName === targetName || listedSize === size;
	});

	for (const share of likelyShares) {
		const token = getShareToken(share);
		if (!token) continue;
		if (shareMatchesFile(share, filename, size, mimeType)) {
			return { token, url: `${MOCHA_WEB}/share/${token}` };
		}

		const metadataResponse = await fetch(`${MOCHA_BASE}/api/shares/${encodeURIComponent(token)}`, { method: "GET" }).catch(() => null);
		if (!metadataResponse?.ok) continue;

		const metadata = await metadataResponse.json().catch(() => null);
		const publicShare = metadata?.share ?? metadata;
		if (isShareActive(publicShare) && shareMatchesFile(publicShare, filename, size, mimeType)) {
			return { token, url: `${MOCHA_WEB}/share/${token}` };
		}
	}

	return null;
}

export async function createShare(apiKey: string, fileId: string, shareExpiry: ShareExpiry): Promise<string> {
	const payload: Record<string, unknown> = { fileId };
	const hours = expiryHours(shareExpiry);
	if (hours !== null) payload.expiresInHours = hours;

	const response = await fetch(`${MOCHA_BASE}/api/shares`, {
		method: "POST",
		headers: authHeaders(apiKey, { "Content-Type": "application/json" }),
		body: JSON.stringify(payload)
	});

	if (!response.ok) throw new Error(`Share create failed: ${response.status} ${await response.text()}`);

	const data = await response.json();
	const token = data?.token ?? data?.share?.token;
	if (!token) throw new Error("No share token returned from Mocha");

	return `${MOCHA_WEB}/share/${token}`;
}

export async function findExistingMochaShareOrCreate(
	apiKey: string,
	filename: string,
	size: number,
	mimeType: string,
	shareExpiry: ShareExpiry
): Promise<ExistingShareMatch | null> {
	const existingFile = await findExistingMochaFile(apiKey, filename, size, mimeType);
	if (!existingFile) return null;

	const existingShare = await findExistingShare(apiKey, filename, size, mimeType).catch(() => null);
	if (existingShare) return existingShare;

	return { token: "", url: await createShare(apiKey, existingFile.id, shareExpiry) };
}

async function getPresignedPartUrl(apiKey: string, session: any, partNumber: number): Promise<string> {
	const response = await fetch(`${MOCHA_BASE}/api/files/multipart/presigned`, {
		method: "POST",
		headers: authHeaders(apiKey, { "Content-Type": "application/json" }),
		body: JSON.stringify({ ...session, partNumbers: [partNumber], expiresInSeconds: 3600 })
	});

	if (!response.ok) throw new Error(`Presign part ${partNumber} failed: ${response.status} ${await response.text()}`);

	const data = await response.json();
	if (typeof data?.url === "string") return data.url;
	if (typeof data?.presignedUrl === "string") return data.presignedUrl;

	const partUrl = Array.isArray(data?.urls)
		? data.urls.find((entry: any) => entry?.partNumber === partNumber)?.url
		: null;

	if (typeof partUrl !== "string") throw new Error(`No presigned URL returned for part ${partNumber}`);
	return partUrl;
}

async function abortMultipart(apiKey: string, session: any, totalParts: number) {
	await fetch(`${MOCHA_BASE}/api/files/multipart/abort`, {
		method: "POST",
		headers: authHeaders(apiKey, { "Content-Type": "application/json" }),
		body: JSON.stringify({ ...session, partNumbers: Array.from({ length: totalParts }, (_, i) => i + 1) })
	}).catch(() => undefined);
}

export type UploadHandle = {
	readonly cancelled: boolean;
	onProgress: (progress: Partial<UploadProgress>) => void;
};

async function uploadPart(
	handle: UploadHandle,
	apiKey: string,
	session: any,
	chunk: ArrayBuffer,
	partNumber: number,
	totalParts: number,
	completedBytes: number,
	totalBytes: number
): Promise<string> {
	for (let attempt = 1; attempt <= PART_RETRIES; attempt++) {
		if (handle.cancelled) throw new Error("Upload cancelled by user");

		try {
			handle.onProgress({
				phase: attempt === 1 ? "uploading" : "retrying",
				partNumber,
				totalParts,
				status: attempt === 1
					? `Uploading part ${partNumber}/${totalParts} via Mocha...`
					: `Retrying part ${partNumber}/${totalParts} via Mocha...`
			});

			const presignedUrl = await getPresignedPartUrl(apiKey, session, partNumber);
			if (handle.cancelled) throw new Error("Upload cancelled by user");

			// No streaming-body upload here (React Native's fetch doesn't support
			// a ReadableStream request body the way native.ts's did) — the whole
			// part is handed to fetch as one ArrayBuffer, so progress is reported
			// per-part-completed rather than continuously while the part is sent.
			const response = await fetch(presignedUrl, {
				method: "PUT",
				headers: { "Content-Length": String(chunk.byteLength) },
				body: chunk
			});

			if (handle.cancelled) throw new Error("Upload cancelled by user");

			if (!response.ok) {
				throw new Error(`Part ${partNumber} failed: ${response.status} ${await response.text()}`);
			}

			const etag = response.headers.get("ETag");
			if (!etag) throw new Error(`No ETag returned for part ${partNumber}`);

			const transferredBytes = Math.min(totalBytes, completedBytes + chunk.byteLength);
			handle.onProgress({
				phase: "uploading",
				percent: Math.min(99, Math.round(transferredBytes / totalBytes * 100)),
				transferredBytes,
				totalBytes,
				partNumber,
				totalParts,
				status: `Uploaded part ${partNumber}/${totalParts}.`
			});

			return etag;
		} catch (error) {
			if (attempt === PART_RETRIES) throw error;
			await new Promise(resolve => setTimeout(resolve, attempt * 1000));
		}
	}

	throw new Error(`Part ${partNumber} failed`);
}

async function uploadMultipart(
	handle: UploadHandle,
	apiKey: string,
	fileBuffer: ArrayBuffer,
	filename: string,
	mimeType: string,
	destinationFolder: string,
	chunkOptions?: ChunkOptions
): Promise<string> {
	const remotePath = `${destinationFolder}/`;
	const size = fileBuffer.byteLength;
	const chunkSize = resolveChunkSize(size, chunkOptions);

	const initResponse = await fetch(`${MOCHA_BASE}/api/files/multipart/init`, {
		method: "POST",
		headers: authHeaders(apiKey, { "Content-Type": "application/json" }),
		body: JSON.stringify({ originalName: filename, path: remotePath, size, mimeType, partSizeBytes: chunkSize, strategy: "s3" })
	});

	if (!initResponse.ok) throw new Error(`Multipart init failed: ${initResponse.status} ${await initResponse.text()}`);

	const initData = await initResponse.json();
	if (initData.strategy !== "s3") throw new Error(`Expected S3 multipart strategy but server returned: ${initData.strategy}`);

	const session = {
		strategy: "s3" as const,
		uploadId: initData.uploadId,
		key: initData.key,
		nodeId: initData.nodeId,
		originalName: filename,
		path: remotePath
	};

	if (!session.uploadId || !session.key || !session.nodeId) {
		throw new Error(`Invalid multipart init response: ${JSON.stringify(initData)}`);
	}

	const totalParts = Math.ceil(size / chunkSize);
	const parts: Array<{ partNumber: number; etag: string; }> = [];
	let completedBytes = 0;

	try {
		for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
			if (handle.cancelled) throw new Error("Upload cancelled by user");

			const offset = (partNumber - 1) * chunkSize;
			const chunk = fileBuffer.slice(offset, Math.min(size, offset + chunkSize));
			const etag = await uploadPart(handle, apiKey, session, chunk, partNumber, totalParts, completedBytes, size);

			completedBytes += chunk.byteLength;
			parts.push({ partNumber, etag });
		}
	} catch (error) {
		await abortMultipart(apiKey, session, totalParts);
		throw error;
	}

	handle.onProgress({
		phase: "uploading",
		percent: 99,
		transferredBytes: size,
		totalBytes: size,
		partNumber: totalParts,
		totalParts,
		status: "Finalizing multipart upload..."
	});

	const completeResponse = await fetch(`${MOCHA_BASE}/api/files/multipart/complete`, {
		method: "POST",
		headers: authHeaders(apiKey, { "Content-Type": "application/json" }),
		body: JSON.stringify({ ...session, size, mimeType, parts: parts.sort((a, b) => a.partNumber - b.partNumber) })
	});

	if (!completeResponse.ok) throw new Error(`Multipart complete failed: ${completeResponse.status} ${await completeResponse.text()}`);

	return getFileId(await completeResponse.json());
}

/**
 * Uploads a file already held in memory as an ArrayBuffer (decoded from the
 * base64 string RNFileModule.readFile gives us) and returns a Mocha share URL.
 *
 * This is the mobile equivalent of native.ts's uploadToMocha/uploadPathToMocha —
 * collapsed into one function because there's no separate "path" vs "buffer"
 * fast path here; everything goes through RNFileModule first regardless.
 */
export async function uploadBufferToMocha(
	fileBuffer: ArrayBuffer,
	filename: string,
	mimeType: string,
	apiKey: string,
	shareExpiry: ShareExpiry,
	chunkOptions: ChunkOptions | undefined,
	handle: UploadHandle
): Promise<UploadResult> {
	try {
		const destinationFolder = `/discord/${today()}`;
		const resolvedMimeType = mimeType || "application/octet-stream";

		handle.onProgress({
			phase: "preparing",
			percent: 1,
			transferredBytes: 0,
			totalBytes: fileBuffer.byteLength,
			status: "Checking Mocha for an existing share..."
		});

		const existingShare = await findExistingMochaShareOrCreate(
			apiKey,
			filename,
			fileBuffer.byteLength,
			resolvedMimeType,
			shareExpiry
		).catch(() => null);

		if (existingShare) {
			handle.onProgress({
				phase: "success",
				percent: 100,
				transferredBytes: fileBuffer.byteLength,
				totalBytes: fileBuffer.byteLength,
				status: "Existing Mocha share found."
			});
			return { success: true, url: existingShare.url };
		}

		await ensureFolder(apiKey, destinationFolder);

		const fileId = await uploadMultipart(handle, apiKey, fileBuffer, filename, resolvedMimeType, destinationFolder, chunkOptions);

		handle.onProgress({
			phase: "sharing",
			percent: 99,
			transferredBytes: fileBuffer.byteLength,
			totalBytes: fileBuffer.byteLength,
			status: "Creating Mocha share link..."
		});

		return { success: true, url: await createShare(apiKey, fileId, shareExpiry) };
	} catch (error) {
		handle.onProgress({
			phase: handle.cancelled ? "cancelled" : "failed",
			status: describeError(error)
		});
		return { success: false, error: describeError(error) };
	}
}
