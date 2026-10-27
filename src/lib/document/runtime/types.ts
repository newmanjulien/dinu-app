import { sameSourceRange } from '$lib/contract/source-model';
import type { ContractBlock } from '$lib/contract/model';
import type { DocumentOverlayItem } from '$lib/playbook/document-overlay';
import type { SourceIndex } from '$lib/contract/source-index';
import type { Address } from '$lib/contract/numbering';
import type { ContractChange, ConcessionSelection } from '$lib/playbook/model';
import type { PaginatedPage } from '../pagination/types';

export type { ConcessionSelection } from '$lib/playbook/model';
export const EMPTY_PREVIEW_CHANGES: readonly ContractChange[] = Object.freeze([]);
export interface ContractRenderSource {
	readonly revision: number;
	readonly blocks: readonly ContractBlock[];
	readonly items: readonly DocumentOverlayItem[];
	readonly sourceIndex: SourceIndex;
}
export interface RenderSnapshot {
	readonly id: number;
	readonly layoutEpoch: string;
	readonly changedPages: readonly number[];
	readonly source: ContractRenderSource;
	readonly concessions: ConcessionSelection;
	readonly previewChanges: readonly ContractChange[];
	readonly addresses: ReadonlyMap<string, Address>;
	readonly pages: readonly PaginatedPage[];
}
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
	readonly source: ContractRenderSource;
	readonly concessions: ConcessionSelection;
	readonly previewChanges: readonly ContractChange[];
	readonly layoutEpoch: string | undefined;
	readonly pages: readonly PaginatedPage[];
	readonly progressive: boolean;
	readonly status: 'running' | 'failed';
}
export function samePreviewChanges(
	a: readonly ContractChange[],
	b: readonly ContractChange[]
): boolean {
	return (
		a.length === b.length &&
		a.every(
			(change, i) =>
				sameSourceRange(change.range, b[i].range) &&
				JSON.stringify(change.replacement) === JSON.stringify(b[i].replacement)
		)
	);
}

/** Detach draft proxies and freeze everything read by an asynchronous render. */
export function snapshotPreviewChanges(
	changes: readonly ContractChange[]
): readonly ContractChange[] {
	if (!changes.length) return EMPTY_PREVIEW_CHANGES;
	return Object.freeze(
		changes.map((change) => {
			const copy = {
				range: Object.freeze({
					start: Object.freeze({ ...change.range.start }),
					end: Object.freeze({ ...change.range.end })
				}),
				replacement: change.replacement.map((atom) => Object.freeze({ ...atom }))
			};
			Object.freeze(copy.replacement);
			return Object.freeze(copy);
		})
	);
}
