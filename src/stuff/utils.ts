import { vstorage } from "..";

export function formatBytes(bytes: number): string {
	if (!bytes) return "";

	const units = ["B", "KB", "MB", "GB"];
	let value = bytes;
	let unitIndex = 0;

	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex++;
	}

	return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

export function debugLog(...args: unknown[]) {
	if (!vstorage.debug) return;
	console.log("[EquiMocha Debug]", ...args);
}

export function isConfigured(): boolean {
	return Boolean(vstorage.apiKey?.trim());
}

export function chunkOptions(): { chunkSizeMB: number; maxChunks: number; } {
	const chunkSizeMB = Math.min(1000, Math.max(5, Math.round(vstorage.chunkSizeMB) || 10));
	const maxChunks = Math.min(10000, Math.max(1, Math.round(vstorage.maxChunks) || 10000));
	return { chunkSizeMB, maxChunks };
}
