export type ContractBlock = import('./source-model').BaselineBlock;
export type InlineAtom = import('./source-model').ReplacementInline;
export type ContractView = 'effective' | 'redline';
export interface ResolvedRun {
	text: string;
	source?: import('./source-model').SourceRange;
	sourceKind?: 'text' | 'reference' | 'number';
	generated?: 'replacement' | 'number' | 'separator' | 'empty-hit-target';
	revision?: 'removed' | 'added';
	/** Visual provenance only; generated text is never baseline-selectable. */
	visualSource?: import('./source-model').SourceTarget;
	generatedOffset?: number;
	annotations?: import('../playbook/document-overlay').AnnotationMembership[];
}
export type ResolvedBlock =
	| {
			kind: 'heading';
			blockKey: string;
			anchor: string;
			level: 1 | 2 | 3;
			content: ResolvedRun[];
			/** Exact source-owned boundaries physically hosted after this output block. */
			boundariesAfter?: readonly import('./source-index').StructuralBoundary[];
	  }
	| {
			kind: 'paragraph';
			blockKey: string;
			content: ResolvedRun[];
			/** Exact source-owned boundaries physically hosted after this output block. */
			boundariesAfter?: readonly import('./source-index').StructuralBoundary[];
	  }
	| {
			kind: 'table';
			blockKey: string;
			variant?: 'signature';
			headerRowCount: number;
			rows: { content: ResolvedRun[] }[][];
	  };
