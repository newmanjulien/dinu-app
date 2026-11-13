export const DISCUSSION_TEXT_LIMIT = 20_000;
export const validDiscussionText = (text: string, allowEmpty = false) =>
	(allowEmpty || Boolean(text.trim())) && text.length <= DISCUSSION_TEXT_LIMIT;
