// "Upload to Mocha" entry on the message long-press action sheet.
//
// This is the closest mobile equivalent to index.tsx's messageContextMenuPatch /
// imageContextMenuPatch (the desktop right-click menu items on messages/images). It's
// reached the same way local-pins reaches MessageLongPressActionSheet: patch
// LazyActionSheet.openLazy, check the sheet key, then splice a row into the rendered
// sheet's button list once the lazy component resolves.
//
// Two different things are confirmed separately here, from local-pins and vdp-shared's
// RedesignRow respectively:
//   - The *container* we search the rendered tree for is the array of existing rows,
//     found via findInReactTree(..., x => x[0]?.type?.name === "ButtonRow") — that's the
//     list we push our own entry into.
//   - The *row component* we render inside that array is ActionSheetRow (FormRow as a
//     fallback on older clients) — not ButtonRow itself, which is just the container.
//
// Caveat worth being upfront about: both of those are internal React tree/component names
// that Discord can and does restructure between versions without warning. The slash
// command in commands.ts doesn't depend on any of this and will keep working even if this
// action sheet patch silently stops finding its target — that's deliberate, treat this
// file as "nice to have, expect it to occasionally need a fix" rather than the primary way
// to trigger an upload.

import { findByProps } from "@vendetta/metro";
import { React } from "@vendetta/metro/common";
import { after, before } from "@vendetta/patcher";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { findInReactTree } from "@vendetta/utils";

import { getMessageMediaUrl } from "./media";
import { runUploadFromUrl } from "./uploadFromUrl";

const LazyActionSheet = findByProps("openLazy", "hideActionSheet") as {
	openLazy: (component: Promise<any>, key: string, props?: object) => void;
	hideActionSheet: () => void;
};

// ActionSheetRow is the actual row primitive modern Discord action sheets render with
// (confirmed via vdp-shared's RedesignRow, the row component the local-pins plugin and
// others actually use for this same kind of injection) — with FormRow as a fallback for
// older clients that haven't been redesigned onto ActionSheetRow yet.
const { ActionSheetRow } = findByProps("ActionSheetRow") ?? {};
const { FormRow } = findByProps("FormRow") ?? {};

function UploadToMochaRow({ url }: { url: string; }) {
	const icon = getAssetIDByName("UploadIcon");
	const onPress = () => {
		LazyActionSheet.hideActionSheet();
		void runUploadFromUrl(url);
	};

	if (ActionSheetRow) {
		return (
			<ActionSheetRow
				label="Upload to Mocha"
				icon={<ActionSheetRow.Icon source={icon} />}
				onPress={onPress}
			/>
		);
	}

	return <FormRow label="Upload to Mocha" leading={<FormRow.Icon source={icon} />} onPress={onPress} />;
}

export default function patchMessageActionSheet() {
	return before("openLazy", LazyActionSheet, ([component, key, args]: [Promise<any>, string, any]) => {
		if (key !== "MessageLongPressActionSheet") return;

		const message = args?.message;
		const url = message ? getMessageMediaUrl(message) : null;
		if (!url) return;

		component.then(imported => {
			const unpatch = after("default", imported, (_args, rendered) => {
				React.useEffect(() => unpatch, []);

				const buttons = findInReactTree(rendered, (x: any) => x[0]?.type?.name === "ButtonRow");
				if (!Array.isArray(buttons)) return rendered;

				buttons.push(React.createElement(UploadToMochaRow, { url }));
				return rendered;
			});
		});
	});
}
