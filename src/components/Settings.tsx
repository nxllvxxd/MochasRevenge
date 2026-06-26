// Settings screen.
//
// Vencord's settings were declared with definePluginSettings(), a schema object the
// desktop client turns into a settings UI automatically. Revenge/Vendetta has no
// schema-driven settings system for third-party plugins — instead a plugin exports a
// `settings` React component directly, and you build the form yourself with Forms.* from
// @vendetta/ui/components. This mirrors clean-urls/customrpc's Settings.tsx pattern,
// just using bare Forms components (no shared monorepo-only helpers) since this is a
// standalone plugin, not part of a larger plugin collection.

import { ReactNative as RN } from "@vendetta/metro/common";
import { useProxy } from "@vendetta/storage";
import { getAssetIDByName } from "@vendetta/ui/assets";
import { Forms } from "@vendetta/ui/components";

import { vstorage } from "..";

const { FormSection, FormRow, FormSwitchRow, FormInput, FormDivider } = Forms;

const EXPIRY_OPTIONS: Array<{ label: string; value: string; }> = [
	{ label: "Never", value: "never" },
	{ label: "1 day", value: "1d" },
	{ label: "7 days", value: "7d" },
	{ label: "30 days", value: "30d" }
];

export default function Settings() {
	useProxy(vstorage);

	return (
		<RN.ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 16 }}>
			<FormSection title="Mocha account">
				<FormInput
					title="API Key"
					placeholder="mocha_xxxxxxxxx"
					value={vstorage.apiKey}
					onChange={(value: string) => (vstorage.apiKey = value)}
					secureTextEntry
				/>
			</FormSection>

			<FormDivider />

			<FormSection title="Upload behavior">
				<FormSwitchRow
					label="Auto-send uploaded links"
					subLabel="If off, links are copied to the clipboard instead of sent to chat"
					leading={<FormRow.Icon source={getAssetIDByName("SendMessageIcon")} />}
					value={vstorage.autoSend}
					onValueChange={(value: boolean) => (vstorage.autoSend = value)}
				/>
				<FormSwitchRow
					label="Log requests to console"
					subLabel="Useful for debugging upload failures"
					leading={<FormRow.Icon source={getAssetIDByName("WarningIcon")} />}
					value={vstorage.debug}
					onValueChange={(value: boolean) => (vstorage.debug = value)}
				/>
			</FormSection>

			<FormDivider />

			<FormSection title="Share expiry">
				{EXPIRY_OPTIONS.map(option => (
					<FormRow
						key={option.value}
						label={option.label}
						trailing={vstorage.shareExpiry === option.value ? FormRow.Arrow : undefined}
						onPress={() => (vstorage.shareExpiry = option.value as any)}
					/>
				))}
			</FormSection>

			<FormDivider />

			<FormSection title="Multipart upload">
				<FormInput
					title="Chunk size (MB)"
					placeholder="10"
					value={String(vstorage.chunkSizeMB)}
					keyboardType="number-pad"
					onChange={(value: string) => (vstorage.chunkSizeMB = Number(value) || 10)}
				/>
				<FormInput
					title="Max chunks"
					placeholder="10000"
					value={String(vstorage.maxChunks)}
					keyboardType="number-pad"
					onChange={(value: string) => (vstorage.maxChunks = Number(value) || 10000)}
				/>
			</FormSection>

			<RN.View style={{ marginHorizontal: 16, marginTop: 16 }}>
				<Forms.FormText style={{ opacity: 0.6 }}>
					Use /mocha-upload in any channel to pick a file and upload it. Long-pressing a message
					with an image or video attached also offers an "Upload to Mocha" option, on a best-effort
					basis — that part of the plugin patches Discord's internal action sheet and may
					occasionally stop matching after a Discord update.
				</Forms.FormText>
			</RN.View>
		</RN.ScrollView>
	);
}
