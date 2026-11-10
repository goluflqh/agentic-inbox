export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export function validateAttachmentSizes(sizes: number[]): string | null {
	if (sizes.length > MAX_ATTACHMENT_COUNT) return `Choose at most ${MAX_ATTACHMENT_COUNT} files.`;
	if (sizes.some((size) => !Number.isSafeInteger(size) || size < 0)) return "Invalid attachment size.";
	if (sizes.reduce((total, size) => total + size, 0) > MAX_ATTACHMENT_BYTES) return "Attachments must total at most 5 MiB.";
	return null;
}
