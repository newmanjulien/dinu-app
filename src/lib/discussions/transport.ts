import { v } from 'convex/values';
import { validate } from 'convex-helpers/validators';
import { readTextBody } from '../http-body';
import { discussionCommand } from './validators';
export const discussionRequest = v.union(
	v.object({ kind: v.literal('viewer'), token: v.string() }),
	v.object({
		kind: v.literal('write'),
		token: v.string(),
		operationId: v.string(),
		expectedAuthorKey: v.string(),
		command: discussionCommand
	})
);
export async function readDiscussionRequest(request: Request) {
	const reader = request.body?.getReader();
	if (!reader) return null;
	try {
		const text = await readTextBody(reader, 150_000);
		if (text === null) return null;
		const value: unknown = JSON.parse(text);
		return validate(discussionRequest, value) ? value : null;
	} catch {
		return null;
	}
}
