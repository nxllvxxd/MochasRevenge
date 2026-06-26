// File picking + base64 conversion.
//
// Vencord's native.ts read files straight off disk with Node's fs (open/read into a
// reusable buffer, one chunk at a time) and got an arbitrary local path either from
// Electron's dialog.showOpenDialog or from a File object's .path property exposed by
// the desktop webview. Neither exists here.
//
// On Revenge, the only file-picking surface is react-native-document-picker (older
// clients) or @react-native-documents/picker (newer clients) — both exposed pre-found
// via $/deps in community plugins. Whichever is present hands back a content:// or
// file:// URI, not a plain path, and the only way to get bytes from it is
// RNFileModule.readFile(path, "base64"), which loads the entire file into memory as
// one base64 string. There is no chunked/streaming read available from JS.

import { findByProps } from "@vendetta/metro";

const DocumentPicker = findByProps("pickSingle", "isCancel") as
	| typeof import("react-native-document-picker")
	| undefined;
const DocumentsNew = findByProps("pick", "saveDocuments") as
	| typeof import("@react-native-documents/picker")
	| undefined;

// RNFileModule comes from a native turbo-module/legacy-module proxy, not a normal
// Metro export. This getNativeModule helper and the NativeFileModule/DCDFileManager
// name fallback are taken directly from revenge-bundle's own native/modules source
// (community plugins re-export this verbatim since the bundle doesn't expose it itself).
type RNFileModuleType = {
	readFile(path: string, encoding: "base64" | "utf8"): Promise<string>;
	getSize?: (uri: string) => Promise<number>;
};

function getNativeModule<T = any>(...names: string[]): T | undefined {
	const nmp = (window as any).nativeModuleProxy ?? {};

	for (const name of names) {
		if ((globalThis as any).__turboModuleProxy) {
			const module = (globalThis as any).__turboModuleProxy(name);
			if (module) return module as T;
		}

		if (nmp[name]) return nmp[name] as T;
	}

	return undefined;
}

function getRNFileModule(): RNFileModuleType | undefined {
	return getNativeModule<RNFileModuleType>("NativeFileModule", "DCDFileManager");
}

export type PickedFile = {
	uri: string;
	name: string;
	mimeType: string;
	size: number;
};

// readFile expects a "full path to file" — per revenge-bundle's own type comments,
// that includes the file:// or content:// scheme on Android, so the URI from the
// document picker is passed straight through rather than stripped.

export async function pickFile(): Promise<PickedFile | null> {
	if (DocumentsNew) {
		const results = await DocumentsNew.pick({ allowMultiSelection: false }).catch((error: any) => {
			if (DocumentsNew!.isErrorWithCode?.(error) && error.code === "OPERATION_CANCELED") return null;
			throw error;
		});

		const picked = results?.[0];
		if (!picked?.uri) return null;

		const [copyResult] = await DocumentsNew.keepLocalCopy({
			files: [{ uri: picked.uri, fileName: picked.name ?? "upload.bin" }],
			destination: "cachesDirectory"
		});

		if (copyResult.status !== "success") {
			throw new Error(copyResult.copyError || "Failed to copy picked file");
		}

		return {
			uri: copyResult.localUri,
			name: picked.name ?? "upload.bin",
			mimeType: picked.type ?? "application/octet-stream",
			size: picked.size ?? 0
		};
	}

	if (DocumentPicker) {
		const result = await DocumentPicker.pickSingle({ copyTo: "cachesDirectory" }).catch(error => {
			if (DocumentPicker!.isCancel(error)) return null;
			throw error;
		});

		if (!result) return null;

		return {
			uri: result.fileCopyUri ?? result.uri,
			name: result.name ?? "upload.bin",
			mimeType: result.type ?? "application/octet-stream",
			size: result.size ?? 0
		};
	}

	throw new Error("No document picker module is available on this client");
}

/** Reads a picked file's full contents into memory as an ArrayBuffer. */
export async function readFileAsArrayBuffer(uri: string): Promise<ArrayBuffer> {
	const RNFileModule = getRNFileModule();
	if (!RNFileModule) throw new Error("RNFileModule is unavailable on this client");

	const base64 = await RNFileModule.readFile(uri, "base64");
	return base64ToArrayBuffer(base64);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	// React Native's JS environment ships a global atob, same as a browser.
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}

export function guessFilenameFromUrl(url: string): string {
	try {
		const segment = new URL(url).pathname.split("/").pop();
		return segment ? decodeURIComponent(segment) : "upload.bin";
	} catch {
		return "upload.bin";
	}
}
