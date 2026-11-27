export const DISCUSSION_THREAD_LIMIT = 200;
export const DISCUSSION_MESSAGE_LIMIT = 2_000;
export const DISCUSSION_TEXT_LIMIT = 20_000;
export const validDiscussionText = (text: string) =>
	Boolean(text.trim()) && text.length <= DISCUSSION_TEXT_LIMIT;
