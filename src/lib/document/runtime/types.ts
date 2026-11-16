import type { DeepReadonly } from '$lib/immutable';
import type { SourceBlock } from '$lib/document/model';
import type { Address } from '$lib/document/numbering';
import type { SourceIndex } from '$lib/document/source-index';
import { sameSourceTarget } from '$lib/document/source-model';
import type { DocumentOverlayItem } from '$lib/playbook/document-overlay';
import type { ConcessionSelection, ContractChange } from '$lib/playbook/model';
import type { PaginatedPage } from '../pagination/types';

export type { ConcessionSelection } from '$lib/playbook/model';
export const EMPTY_PREVIEW_CHANGES: DeepReadonly<ContractChange[]> = Object.freeze([]);
export interface DocumentRenderSource {
	readonly materialized?: {
		document: import('../contract-document').ContractDocument;
		baseline: readonly SourceBlock[];
	};
	readonly revision: number;
	readonly blocks: readonly SourceBlock[];
	readonly items: readonly DocumentOverlayItem[];
	readonly sourceIndex: SourceIndex;
	readonly artifacts?: import('./artifacts').DocumentArtifacts;
}
export interface RenderSnapshot {
	readonly view: import('$lib/document/model').DocumentView;
	readonly selectionDocument: import('../selection/selection-model').SelectionDocument;
	readonly panelSourceFacts?: import('../panel-source-facts').PanelSourceFacts;
	readonly id: number;
	readonly layoutEpoch: string;
	readonly changedPages: readonly number[];
	readonly source: DocumentRenderSource;
	readonly concessions: ConcessionSelection;
	readonly previewChanges: DeepReadonly<ContractChange[]>;
	readonly addresses: ReadonlyMap<string, Address>;
	readonly pages: readonly PaginatedPage[];
}
/** The exact mounted pages and source needed to paint annotation highlights. */
export type AnnotationProjectionDocument = Pick<
	RenderSnapshot,
	'id' | 'layoutEpoch' | 'view' | 'source' | 'concessions' | 'pages'
>;
export interface SourceIssue {
	blocksFailed: boolean;
	itemsFailed: boolean;
}
export interface RenderFailure {
	message: string;
	cause?: unknown;
}
export interface RenderJobMeta {
	generation: number;
	sourceRevision: number;
	readonly source: DocumentRenderSource;
	readonly concessions: ConcessionSelection;
	readonly previewChanges: DeepReadonly<ContractChange[]>;
	readonly layoutEpoch: string | undefined;
	readonly pages: readonly PaginatedPage[];
	/** Exact closed pages can be admitted independently of complete custom metadata. */
	readonly initialBatchReady: boolean;
	readonly paginationComplete: boolean;
	readonly progressive: boolean;
	readonly status: 'running' | 'failed';
}
export function samePreviewChanges(
	a: DeepReadonly<ContractChange[]>,
	b: DeepReadonly<ContractChange[]>
): boolean {
	if (a === b) return true;
	return (
		a.length === b.length &&
		a.every(
			(change, i) =>
				sameSourceTarget(change.target, b[i].target) &&
				JSON.stringify(change.replacement) === JSON.stringify(b[i].replacement)
		)
	);
}
