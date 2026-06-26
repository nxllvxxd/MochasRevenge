// Lightweight ephemeral upload-progress store.
//
// Vencord's index.tsx used a module-level object + Set<listener> with a useState/useEffect
// hook to subscribe — no external state library, just enough to drive a progress bar
// component. There's no reason to reach for zustand (which several Revenge plugins use,
// but only because they're part of a monorepo that already depends on it) for something
// this small, so this keeps the original's plain-listener-set approach as-is. It works
// identically under React Native's React as it did under the desktop client's React.

import { React } from "@vendetta/metro/common";
import type { UploadPhase } from "./api";

export type UploadProgressState = {
	phase: UploadPhase | "idle";
	fileName: string;
	attempt: number;
	totalAttempts: number;
	percent: number;
	transferredBytes: number;
	totalBytes: number;
	status: string;
	canCancel: boolean;
};

const defaultState: UploadProgressState = {
	phase: "idle",
	fileName: "",
	attempt: 0,
	totalAttempts: 0,
	percent: 0,
	transferredBytes: 0,
	totalBytes: 0,
	status: "",
	canCancel: false
};

let state: UploadProgressState = { ...defaultState };
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

export function setUploadState(patch: Partial<UploadProgressState>) {
	state = { ...state, ...patch };
	emit();
}

export function resetUploadState() {
	state = { ...defaultState };
	emit();
}

export function getUploadState(): UploadProgressState {
	return state;
}

export function subscribeUploadState(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useUploadState(): UploadProgressState {
	const [snapshot, setSnapshot] = React.useState(getUploadState);

	React.useEffect(() => subscribeUploadState(() => setSnapshot(getUploadState())), []);

	return snapshot;
}

let cancelRequested = false;
let isUploading = false;

export function getIsUploading(): boolean {
	return isUploading;
}

export function setIsUploading(value: boolean) {
	isUploading = value;
	if (value) cancelRequested = false;
}

export function requestCancel() {
	cancelRequested = true;
}

export function wasCancelRequested(): boolean {
	return cancelRequested;
}
