export type { SourceBlock } from './source-model';
export type InlineAtom = import('./source-model').ReplacementInline;
export type DocumentView = 'effective' | 'redline';
export interface ResolvedRun {
	text: string;
	source?: import('./source-model').SourceRange;
	/** Immutable discussion coordinates when materialized pieces have new local keys. */
	sourceOrigin?: import('./source-model').SourceRange;
	sourceKind?: 'text' | 'reference' | 'number';
	generated?: 'replacement' | 'number' | 'separator' | 'empty-hit-target';
	revision?: 'removed' | 'added';
	/** Visual provenance only; generated text is never source-selectable. */
	visualSource?: import('./source-model').SourceTarget;
	/** Discussion address stays invariant between readable redlines and effective text. */
	discussion?: {
		origin: NonNullable<ResolvedRun['generatedOrigin']>;
		offset: number;
		atomic?: true;
	};
	generatedOffset?: number;
	generatedOrigin?: { itemId: string; concessionId: string; changeIndex: number };
	annotations?: import('../playbook/document-overlay').AnnotationMembership[];
}
export type ResolvedBlock =
	| {
			kind: 'paragraph';
			discussionRemoved?: true;
			role: import('./source-model').ParagraphRole;
			anchor?: string;
			/** Legal depth is independent of the flat presentation role. */
			numberingDepth?: number;
			continueNumbering?: false;
			blockKey: string;
			content: ResolvedRun[];
			/** Exact source-owned boundaries physically hosted after this output block. */
			boundariesAfter?: readonly import('./source-index').StructuralBoundary[];
	  }
	| import('./source-model').SourceTable;
