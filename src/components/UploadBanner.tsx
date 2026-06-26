// Optional small progress banner.
//
// index.tsx rendered its ProgressBar by patching a chat-input-adjacent component
// (a `find: ".CREATE_FORUM_POST||"` webpack patch with a regex replace) to mount it
// directly above the message composer. That patch target is desktop-only code and the
// regex won't match anything in the mobile bundle.
//
// Finding and patching the equivalent mobile chat input component reliably is realistic
// but fiddly, and toasts already cover "is it working / did it fail" feedback for a
// single-file upload that usually finishes in a few seconds. So rather than guess at an
// undocumented mobile chat-input patch target, this ships as a small standalone component
// you can mount wherever makes sense (e.g. from the same action sheet patch, as a custom
// alert, or just left unused if the toasts are enough on their own).

import { React, ReactNative as RN } from "@vendetta/metro/common";

import { cancelCurrentUpload } from "../stuff/upload";
import { useUploadState } from "../stuff/uploadState";
import { formatBytes } from "../stuff/utils";

export default function UploadBanner() {
	const state = useUploadState();

	if (state.phase === "idle") return null;

	const percentage = Math.max(0, Math.min(100, state.percent));
	const progressLabel = state.totalBytes > 0
		? `${Math.round(percentage)}% - ${formatBytes(state.transferredBytes)} of ${formatBytes(state.totalBytes)}`
		: `${Math.round(percentage)}%`;

	return (
		<RN.View style={{ padding: 12, borderRadius: 8, backgroundColor: "rgba(0,0,0,0.4)" }}>
			<RN.View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
				<RN.Text style={{ color: "white", fontWeight: "600" }}>
					{state.status || "Uploading..."}
				</RN.Text>
				{state.canCancel && (
					<RN.Pressable onPress={cancelCurrentUpload}>
						<RN.Text style={{ color: "white", fontWeight: "600" }}>✕</RN.Text>
					</RN.Pressable>
				)}
			</RN.View>
			<RN.View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 4 }}>
				<RN.Text style={{ color: "white" }}>{progressLabel}</RN.Text>
				{state.attempt > 0 && state.totalAttempts > 0 && (
					<RN.Text style={{ color: "white" }}>{`${state.attempt}/${state.totalAttempts}`}</RN.Text>
				)}
			</RN.View>
			<RN.View style={{ height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.2)", marginTop: 8 }}>
				<RN.View
					style={{
						height: 4,
						borderRadius: 2,
						backgroundColor: "white",
						width: `${percentage}%`
					}}
				/>
			</RN.View>
			<RN.Text style={{ color: "rgba(255,255,255,0.7)", marginTop: 4, fontSize: 12 }}>
				{state.fileName || ""}
			</RN.Text>
		</RN.View>
	);
}
