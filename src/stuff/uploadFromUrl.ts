// Ported from index.tsx's uploadFile(url) — fetches a remote URL's bytes and re-uploads
// them to Mocha. Unlike picking a local file, this doesn't need RNFileModule at all:
// React Native's fetch can return an ArrayBuffer directly via response.arrayBuffer(),
// the same as the original's native.ts fetchUrlAndUpload did with Node's fetch.
// Context-menu-triggered uploads always copy the link to the clipboard rather than
// auto-sending, matching the original's behavior for menu-triggered uploads.

import { clipboard } from "@vendetta/metro/common";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { showToast } from "@vendetta/ui/toasts";

import { uploadBufferToMocha } from "./api";
import { guessFilenameFromUrl } from "./files";
import {
	getIsUploading,
	resetUploadState,
	setIsUploading,
	setUploadState,
	wasCancelRequested
} from "./uploadState";
import { chunkOptions, debugLog, isConfigured } from "./utils";
import { vstorage } from "..";

export async function runUploadFromUrl(sourceUrl: string): Promise<void> {
	if (getIsUploading()) {
		showToast("Upload already in progress", getAssetIDByName("WarningIcon"));
		return;
	}

	if (!isConfigured()) {
		showToast("Please configure EquiMocha settings first", getAssetIDByName("CircleXIcon-primary"));
		return;
	}

	const filename = guessFilenameFromUrl(sourceUrl);
	setIsUploading(true);

	setUploadState({
		phase: "preparing",
		fileName: filename,
		attempt: 0,
		totalAttempts: 0,
		percent: 1,
		transferredBytes: 0,
		totalBytes: 0,
		status: "Fetching file...",
		canCancel: false
	});

	try {
		const response = await fetch(sourceUrl);
		if (!response.ok) throw new Error(`Failed to fetch file: ${response.status}`);

		const mimeType = (response.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
		const fileBuffer = await response.arrayBuffer();

		const result = await uploadBufferToMocha(
			fileBuffer,
			filename,
			mimeType,
			vstorage.apiKey.trim(),
			vstorage.shareExpiry,
			chunkOptions(),
			{
				get cancelled() {
					return wasCancelRequested();
				},
				onProgress: progress => {
					setUploadState({
						phase: (progress.phase === "sharing" ? "uploading" : progress.phase) as any,
						attempt: progress.partNumber,
						totalAttempts: progress.totalParts,
						percent: progress.percent,
						transferredBytes: progress.transferredBytes,
						totalBytes: progress.totalBytes,
						status: progress.status,
						canCancel: false
					});
				}
			}
		);

		debugLog("url upload result", result);

		if (!result.success || !result.url) {
			throw new Error(result.error || "Native Mocha upload failed");
		}

		setUploadState({
			phase: "success",
			percent: 100,
			status: "Uploaded successfully via Mocha.",
			canCancel: false
		});

		// Context-menu / action-sheet uploads always copy to clipboard — never auto-send.
		clipboard.setString(result.url);
		showToast("Link copied to clipboard", getAssetIDByName("CopyIcon"));
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";

		if (wasCancelRequested()) {
			showToast("Upload cancelled", getAssetIDByName("WarningIcon"));
			setUploadState({ phase: "cancelled", status: "Upload cancelled.", canCancel: false, percent: 0 });
		} else {
			showToast(`Upload failed: ${message}`, getAssetIDByName("CircleXIcon-primary"));
			console.error("[EquiMocha]", error);
			setUploadState({ phase: "failed", status: `Upload failed: ${message}`, canCancel: false, percent: 0 });
		}
	} finally {
		setIsUploading(false);
		setTimeout(() => resetUploadState(), 1800);
	}
}
