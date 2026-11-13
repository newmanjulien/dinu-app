export const HIGHLIGHT_THEME = {
	'rep-attachment': { priority: 0 },
	'buyer-attachment': { priority: 0 },
	'discussion-proposal': { priority: 0 },
	'revision-added': { priority: 1 },
	'revision-removed': { priority: 1 },
	'search-match': { priority: 2 },
	'search-active': { priority: 3 },
	'authoring-selection': { priority: 4 },
	'native-selection': { priority: 5 }
} as const;

export type HighlightKind = keyof typeof HIGHLIGHT_THEME;
export type AttachmentHighlightKind = 'rep-attachment' | 'buyer-attachment';
