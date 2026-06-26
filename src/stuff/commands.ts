// /mocha-upload slash command — the primary entry point for this plugin.
//
// This replaces everything in index.tsx that hooked into Discord's own upload pipeline
// (the FluxDispatcher interceptor, paste/drag/file-input listeners). None of those desktop
// DOM/Electron hooks exist on mobile, and there's no public hook into the native attachment
// picker/sender to intercept either. A slash command is the most reliable trigger surface
// Revenge gives third-party plugins, and it conveniently hands us ctx.channel.id directly —
// no need to reach for a SelectedChannelStore equivalent.
//
// The "copy-only" boolean option mirrors the original's context-menu-triggered uploads
// (which always copied rather than sent) — here it's explicit instead of implicit, since
// there's no separate "regular upload" vs "context menu upload" trigger to distinguish by.

import { registerCommand } from "@vendetta/commands";

import { runPickAndUpload } from "./upload";

// ApplicationCommandOptionType is a global ambient `const enum` declared by vendetta-types
// (confirmed in its defs.d.ts) — it's never exported from any @vendetta/* module, so it's
// used here as a bare global rather than imported. tsconfig.json includes
// node_modules/vendetta-types/defs.d.ts so this resolves at compile time without an
// import statement; at runtime it's just the literal number this enum member compiles to.

export default function patchCommands() {
	return registerCommand({
		name: "mocha-upload",
		description: "Pick a file and upload it to Mocha",
		options: [
			{
				name: "copy-only",
				description: "Copy the share link to clipboard instead of sending it",
				type: ApplicationCommandOptionType.BOOLEAN,
				required: false
			}
		],
		execute([copyOnlyArg], ctx) {
			const copyOnly = Boolean(copyOnlyArg?.value);
			void runPickAndUpload(ctx.channel?.id, copyOnly);
		}
	} as any);
}
