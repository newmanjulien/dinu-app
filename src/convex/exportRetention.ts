/** Core byte eligibility and cleanup reserve are shared with provider delivery retention. */
export const EXPORT_HOUR = 60 * 60_000;
export const EXPORT_READ_GRACE = 15 * 60_000;
export const EXPORT_ACKNOWLEDGEMENT_WINDOW = 7 * 24 * EXPORT_HOUR;
export function retainedUntil(
	attempt: { createdAt: number },
	delivery?: { remoteFileId?: string; attachmentUntil?: number } | null
) {
	return Math.max(
		attempt.createdAt + EXPORT_HOUR,
		delivery?.remoteFileId ? 0 : (delivery?.attachmentUntil ?? 0)
	);
}
