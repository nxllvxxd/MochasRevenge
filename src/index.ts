import { storage } from "@vendetta/plugin";

import patchCommands from "./stuff/commands";
import patchMessageActionSheet from "./stuff/messageActionSheet";
import Settings from "./components/Settings";

export type ShareExpiry = "never" | "1d" | "7d" | "30d";

export const vstorage = storage as {
	apiKey: string;
	autoSend: boolean;
	shareExpiry: ShareExpiry;
	chunkSizeMB: number;
	maxChunks: number;
	debug: boolean;
};

let unpatchCommands: (() => void) | null = null;
let unpatchActionSheet: (() => void) | null = null;

export function onLoad() {
	vstorage.apiKey ??= "";
	vstorage.autoSend ??= true;
	vstorage.shareExpiry ??= "never";
	vstorage.chunkSizeMB ??= 10;
	vstorage.maxChunks ??= 10000;
	vstorage.debug ??= true;

	unpatchCommands = patchCommands();
	unpatchActionSheet = patchMessageActionSheet();
}

export function onUnload() {
	unpatchCommands?.();
	unpatchCommands = null;

	unpatchActionSheet?.();
	unpatchActionSheet = null;
}

export const settings = Settings;
