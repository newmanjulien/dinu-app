import type { ResolvedRun } from '$lib/contract/model';
import type { StructuralBoundary } from '$lib/contract/source-index';
import type { AnnotationMembership } from '$lib/playbook/document-overlay';
import type { PreparedBlock } from './prepare';

export interface InlineToken extends Readonly<Omit<ResolvedRun, 'text' | 'annotations'>> {
	readonly value: string;
	readonly annotations?: readonly AnnotationMembership[];
}

export type PageFragment = HeadingFragment | ParagraphFragment | TableFragment;

export interface FragmentInterval {
	readonly start: number;
	readonly end: number;
}

export interface HeadingFragment {
	readonly interval?: FragmentInterval;
	readonly type: 'heading';
	readonly blockKey: string;
	readonly anchor: string;
	readonly level: 1 | 2 | 3;
	readonly tokens: readonly InlineToken[];
}

export interface ParagraphFragment {
	readonly interval?: FragmentInterval;
	readonly type: 'paragraph';
	readonly blockKey: string;
	readonly tokens: readonly InlineToken[];
	readonly isContinuation: boolean;
	readonly isFinal: boolean;
}

export interface TableFragment {
	/** Runtime canonical columns, shared by every fragment of a profiled table. */
	readonly columnWidths?: readonly number[];
	/** Body-row interval; repeated headers are outside this interval. */
	readonly interval?: FragmentInterval;
	readonly type: 'table';
	readonly blockKey: string;
	readonly variant?: 'signature';
	readonly headerRowCount: number;
	readonly rows: readonly (readonly { readonly tokens: readonly InlineToken[] }[])[];
}

/** Content identity accompanies placement; geometry alone never authorizes page reuse. */
export interface LayoutPlacement {
	readonly prepared: PreparedBlock;
	readonly fragment: PageFragment;
	/** Explicit source-owned boundaries rendered by this exact physical fragment. */
	readonly structuralBoundaries?: readonly StructuralBoundary[];
}

/** Complete candidate page produced by pure pagination. */
export interface PaginatedPage {
	readonly number: number;
	readonly placements: readonly LayoutPlacement[];
}

export function fragmentKey(fragment: PageFragment): string {
	return `${fragment.blockKey}:${fragment.interval?.start ?? 0}:${fragment.interval?.end ?? 'whole'}`;
}
