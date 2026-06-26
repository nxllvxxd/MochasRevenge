// Ported from index.tsx's getMediaUrl. The desktop version inspected DOM event props
// (img/video/anchor elements, React prop names like itemSrc/itemHref) because the context
// menu fired from an actual rendered HTML element. On mobile there's no DOM — the action
// sheet instead receives the raw message object, so this just walks its attachments and
// embeds directly instead of reverse-engineering synthetic event props.

export function getMessageMediaUrl(message: any): string | null {
	const attachment = message?.attachments?.find((a: any) => typeof a?.url === "string");
	if (attachment) return attachment.url;

	const embed = message?.embeds?.find((e: any) =>
		typeof e?.image?.url === "string" || typeof e?.video?.url === "string" || typeof e?.url === "string"
	);

	if (embed) {
		return embed.video?.url ?? embed.image?.url ?? embed.url ?? null;
	}

	return null;
}
