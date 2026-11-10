type Ranges = {
	comment: Range[];
	proposal: Range[];
	activeComment: Range[];
	activeProposal: Range[];
};
const owners = new Map<symbol, Ranges>();
const names = [
	'dinu-discussion-comment',
	'dinu-discussion-proposal',
	'dinu-discussion-active-comment',
	'dinu-discussion-active-proposal'
] as const;
function publish() {
	if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof Highlight === 'undefined')
		return;
	for (const [index, kind] of (
		['comment', 'proposal', 'activeComment', 'activeProposal'] as const
	).entries()) {
		const ranges = [...owners.values()].flatMap((value) => value[kind]);
		if (!ranges.length) CSS.highlights.delete(names[index]);
		else {
			const highlight = new Highlight(...ranges);
			highlight.priority = 10 + index;
			CSS.highlights.set(names[index], highlight);
		}
	}
}
export function setDiscussionHighlights(owner: symbol, ranges: Ranges) {
	owners.set(owner, ranges);
	publish();
}
export function clearDiscussionHighlights(owner: symbol) {
	if (owners.delete(owner)) publish();
}
