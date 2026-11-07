import { ConvexError } from 'convex/values';
export const MAX_SNAPSHOT_BYTES = 8_000_000;
export function templateRejected(message: string) {
	return new ConvexError({ code: 'TEMPLATE_SAVE_REJECTED', message });
}
