// Upload orchestration — the mobile equivalent of index.tsx's uploadPickedFile / uploadFile /
// uploadProvidedFiles / notifyUploadSuccess.
//
// What's intentionally NOT here, and why:
//
//   - No FluxDispatcher interceptor for UPLOAD_ATTACHMENT_ADD_FILES. That event, and the whole
//     concept of intercepting Discord's own attachment-add pipeline before it reaches the
//     network, is specific to the desktop client's upload flow. Revenge has no equivalent hook
//     into the mobile attachment picker/sender.
//   - No paste/drag/file-input DOM listeners. Those are literally <input>, ClipboardEvent and
//     DragEvent — browser/Electron concepts that don't exist in a React Native app.
//   - No "bypass Discord's size-limit modal" patch. That patch in index.tsx targeted a specific
//     desktop-only nitro-upsell code path; mobile's upload-size handling is different code
//     entirely and hasn't been reverse-engineered here.
//
// What replaces it: a single slash command (/mocha-upload) that opens the document picker,
// uploads what was picked, and either sends the link or copies it — same end *result* as the
// original, reached through a different *trigger*, because the desktop-style triggers don't
// exist on this platform.

import { clipboard, messageUtil } from "@vendetta/metro/common";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import { uploadBufferToMocha, type UploadProgress } from "./api";
import { pickFile, readFileAsArrayBuffer } from "./files";
import {
	getIsUploading,
	requestCancel,
	resetUploadState,
	setIsUploading,
	setUploadState,
	wasCancelRequested
} from "./uploadState";
import { chunkOptions, debugLog, isConfigured } from "./utils";
import { vstorage } from "..";

const MOCHA_SERVICE_LABEL = "Mocha";

function applyProgress(progress: Partial<UploadProgress>) {
	setUploadState({
		phase: (progress.phase === "sharing" ? "uploading" : progress.phase) as any,
		attempt: progress.partNumber,
		totalAttempts: progress.totalParts,
		percent: progress.percent,
		transferredBytes: progress.transferredBytes,
		totalBytes: progress.totalBytes,
		status: progress.status,
		canCancel: progress.phase !== "success" && progress.phase !== "failed" && progress.phase !== "cancelled"
	});
}

async function copyUrlToClipboard(url: string): Promise<void> {
	clipboard.setString(url);
}

async function notifyUploadSuccess(finalUrl: string, channelId: string | undefined, copyOnly: boolean): Promise<void> {
	showToast("Upload successful", getAssetIDByName("CircleCheckIcon-primary"));

	if (!copyOnly && vstorage.autoSend && channelId) {
		messageUtil.sendMessage(channelId, { content: finalUrl }, undefined, { nonce: Date.now().toString() });
		return;
	}

	// Either autoSend is off, or this upload was explicitly requested as
	// copy-only — copy the link to the clipboard so it's immediately usable,
	// same fallback behavior as the desktop plugin's notifyUploadSuccess.
	await copyUrlToClipboard(finalUrl);
	showToast("Link copied to clipboard", getAssetIDByName("CopyIcon"));
}

function isUploadCancelledError(error: unknown): boolean {
	if (wasCancelRequested()) return true;
	if (!(error instanceof Error)) return false;
	const message = error.message.toLowerCase();
	return message.includes("cancelled") || message.includes("canceled");
}

export type UploadOutcome =
	| { kind: "skipped-busy"; }
	| { kind: "skipped-unconfigured"; }
	| { kind: "skipped-no-file"; }
	| { kind: "cancelled"; }
	| { kind: "failed"; message: string; }
	| { kind: "success"; url: string; };

/**
 * Opens the document picker, uploads whatever was selected, and either sends
 * the resulting link to channelId or copies it to the clipboard.
 *
 * This is the merge of uploadPickedFile + uploadToMocha/uploadPathToMocha from
 * the desktop plugin — there's no separate "path" vs "in-memory buffer" fast
 * path on this platform, so it collapses into one function.
 */
export async function runPickAndUpload(channelId: string | undefined, copyOnly: boolean): Promise<UploadOutcome> {
	if (getIsUploading()) {
		showToast("Upload already in progress", getAssetIDByName("WarningIcon"));
		return { kind: "skipped-busy" };
	}

	if (!isConfigured()) {
		showToast("Please configure EquiMocha settings first", getAssetIDByName("CircleXIcon-primary"));
		return { kind: "skipped-unconfigured" };
	}

	const picked = await pickFile().catch(error => {
		debugLog("file pick failed", error);
		return null;
	});

	if (!picked) return { kind: "skipped-no-file" };

	setIsUploading(true);

	setUploadState({
		phase: "preparing",
		fileName: picked.name,
		attempt: 0,
		totalAttempts: 0,
		percent: 1,
		transferredBytes: 0,
		totalBytes: picked.size,
		status: `Preparing ${picked.name}...`,
		canCancel: false // no in-flight network request to cancel yet
	});

	try {
		debugLog("reading picked file", picked);
		const fileBuffer = await readFileAsArrayBuffer(picked.uri);

		const result = await uploadBufferToMocha(
			fileBuffer,
			picked.name,
			picked.mimeType,
			vstorage.apiKey.trim(),
			vstorage.shareExpiry,
			chunkOptions(),
			{
				get cancelled() {
					return wasCancelRequested();
				},
				onProgress: applyProgress
			}
		);

		debugLog("upload result", result);

		if (!result.success || !result.url) {
			throw new Error(result.error || "Native Mocha upload failed");
		}

		setUploadState({
			phase: "success",
			percent: 100,
			status: `Uploaded successfully via ${MOCHA_SERVICE_LABEL}.`,
			canCancel: false
		});

		await notifyUploadSuccess(result.url, channelId, copyOnly);
		return { kind: "success", url: result.url };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";

		if (isUploadCancelledError(error)) {
			showToast("Upload cancelled", getAssetIDByName("WarningIcon"));
			setUploadState({ phase: "cancelled", status: "Upload cancelled.", canCancel: false, percent: 0 });
			return { kind: "cancelled" };
		}

		showToast(`Upload failed: ${message}`, getAssetIDByName("CircleXIcon-primary"));
		console.error("[EquiMocha]", error);
		setUploadState({ phase: "failed", status: `Upload failed: ${message}`, canCancel: false, percent: 0 });
		return { kind: "failed", message };
	} finally {
		setIsUploading(false);
		setTimeout(() => resetUploadState(), 1800);
	}
}

export function cancelCurrentUpload() {
	if (!getIsUploading()) return;
	requestCancel();
	setUploadState({ phase: "cancelled", status: "Upload cancelled.", canCancel: false, percent: 0 });
}
