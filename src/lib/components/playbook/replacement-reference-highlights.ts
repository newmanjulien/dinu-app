const HIGHLIGHT_NAME = 'dinu-replacement-reference';
const entries = new Map<symbol, readonly Range[]>();

function supported() {
	return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

function publish() {
	if (!supported()) return;
	if (!entries.size) {
		CSS.highlights.delete(HIGHLIGHT_NAME);
		return;
	}
	CSS.highlights.set(
		HIGHLIGHT_NAME,
		new Highlight(...[...entries.values()].flatMap((ranges) => ranges))
	);
}

/** One document-level CSS highlight stays noninteractive even when several editors are mounted. */
export function setReplacementReferenceHighlights(owner: symbol, ranges: readonly Range[]) {
	if (!supported()) return;
	entries.set(owner, ranges);
	publish();
}

export function clearReplacementReferenceHighlights(owner: symbol) {
	if (!supported()) return;
	if (!entries.delete(owner)) return;
	publish();
}
