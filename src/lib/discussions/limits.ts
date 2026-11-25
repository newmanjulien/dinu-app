export const DISCUSSION_TEXT_LIMIT = 20_000;
export const validDiscussionText = (text: string) =>
	Boolean(text.trim()) && text.length <= DISCUSSION_TEXT_LIMIT;
