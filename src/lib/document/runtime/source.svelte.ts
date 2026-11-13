import type { ContractItemId } from '$lib/contract/item-identity';
import type { DeepReadonly } from '$lib/immutable';
import { measureStartupWork, recordColdStart, recordDomainWork } from './render-perf';
import type { SourceBlock } from '$lib/document/model';
import type { CompiledDocument } from '$lib/document/compiled-document';
import type { DocumentItemRecord, ResolvedContractItem } from '$lib/contract/items';
import type { PlaybookGeometryIndex } from '$lib/playbook/geometry-index';
import { DocumentDomain } from '../domain/document-domain';
import type { DocumentRenderSource, SourceIssue } from './types';
import type { StructureSnapshot, StructureItem } from '$lib/playbook/structure';
import type { ConcessionSelection } from '$lib/playbook/model';
import type { DocumentAnnotationItem, DocumentOverlayItem } from '$lib/playbook/document-overlay';
import { DocumentArtifacts } from './artifacts';

type QueryValue<T> = { data?: T; error?: unknown };
type CommonSourceInput =
	| { blocks: QueryValue<SourceBlock[]>; contract?: false; materialized?: never }
	| {
			contract: true;
			/** Only ready document + projection inputs may replace the accepted contract. */
			materialized: QueryValue<NonNullable<DocumentRenderSource['materialized']>>;
			blocks?: never;
	  };
export type DocumentSourceInput = CommonSourceInput &
	(
		| {
				kind: 'records';
				items: QueryValue<DeepReadonly<DocumentItemRecord[]>>;
				structure?: never;
				details?: never;
				pendingRenderKey?: never;
				overlays?: never;
		  }
		| {
				kind: 'structure';
				structure: QueryValue<StructureSnapshot>;
				details?: DeepReadonly<DocumentItemRecord[]>;
				pendingRenderKey?: string;
				items?: never;
				overlays?: never;
		  }
		| {
				kind: 'overlays';
				overlays: readonly DocumentOverlayItem[];
				items?: never;
				structure?: never;
				details?: never;
				pendingRenderKey?: never;
		  }
	);

/** Workspace-owned source semantics. Query failures retain accepted data. */
export class DocumentSourceController {
	itemsCurrent = $state(false);
	compactStructure = $state(false);
	items = $state.raw<DeepReadonly<ResolvedContractItem[]> | null>(null);
	structuralItems = $state.raw<DeepReadonly<StructureItem<ContractItemId>[]> | null>(null);
	annotations = $state.raw<readonly DocumentAnnotationItem[]>([]);
	contentOverlays = $state.raw<readonly DocumentOverlayItem[]>([]);
	compiled = $state.raw<CompiledDocument | null>(null);
	geometry = $state.raw<PlaybookGeometryIndex | null>(null);
	geometryVersion = $state(0);
	renderSource = $state.raw<DocumentRenderSource | null>(null);
	issue = $state.raw<SourceIssue | null>(null);
	private selection: ConcessionSelection = {};
	private contentKey = '';
	private materialized?: DocumentRenderSource['materialized'];
	private artifacts?: DocumentArtifacts;

	constructor(readonly domain = new DocumentDomain()) {}
	setSelection(selection: ConcessionSelection) {
		this.selection = selection;
		this.refreshContent();
	}
	private refreshContent() {
		if (!this.compiled || !this.structuralItems) return;
		const items = this.domain.contentOverlays.filter((item) =>
			item.concessions.some((concession) => concession.id === this.selection[item.itemId])
		);
		const key = JSON.stringify(
			items.map((item) => [
				item.itemId,
				item.trigger,
				item.concessions.filter((concession) => concession.id === this.selection[item.itemId])
			])
		);
		if (
			this.renderSource?.sourceIndex === this.compiled.index &&
			this.renderSource.materialized?.document === this.materialized?.document &&
			this.renderSource.materialized?.baseline === this.materialized?.baseline &&
			key === this.contentKey
		)
			return;
		this.contentKey = key;
		if (
			this.artifacts?.source.sourceIndex !== this.compiled.index ||
			this.artifacts?.source.materialized?.document !== this.materialized?.document ||
			this.artifacts?.source.materialized?.baseline !== this.materialized?.baseline
		) {
			this.artifacts?.destroy();
			this.artifacts = undefined;
		}
		const source: DocumentRenderSource = Object.freeze({
			materialized: this.materialized,
			revision: (this.renderSource?.revision ?? 0) + 1,
			blocks: this.compiled.blocks,
			items,
			sourceIndex: this.compiled.index
		});
		this.artifacts ??= new DocumentArtifacts(source);
		this.renderSource = Object.freeze({ ...source, artifacts: this.artifacts });
	}
	destroy() {
		this.artifacts?.destroy();
		this.artifacts = undefined;
	}

	lookup(id: string) {
		return this.domain.lookup(id);
	}

	accept(input: DocumentSourceInput) {
		const startedAt = performance.now();
		try {
			measureStartupWork('sourceAccept', () => this.#accept(input));
		} finally {
			recordColdStart('source-accepted', startedAt);
			recordDomainWork(this.domain);
		}
	}

	#accept(input: DocumentSourceInput) {
		const materialized = input.contract ? input.materialized.data : undefined;
		const blocks = input.contract
			? { data: materialized?.document.blocks, error: input.materialized.error }
			: input.blocks;
		const itemError =
			input.kind === 'records'
				? input.items.error
				: input.kind === 'structure'
					? input.structure.error
					: undefined;
		const projectionReady =
			input.kind === 'overlays' ||
			(input.kind === 'records' ? Boolean(input.items.data) : input.structure.data?.ready);
		// Refresh/error inputs retain accepted geometry, artifacts and pages.
		if (input.contract && (!materialized || !projectionReady || blocks.error || itemError)) {
			this.itemsCurrent = false;
			this.issue =
				blocks.error || itemError
					? { blocksFailed: Boolean(blocks.error), itemsFailed: Boolean(itemError) }
					: null;
			return;
		}
		const rollback = input.contract ? this.domain.checkpoint() : undefined;
		this.compactStructure = input.kind === 'structure';
		let blocksFailed = Boolean(blocks.error),
			itemsFailed = Boolean(
				input.kind === 'structure'
					? input.structure.error
					: input.kind === 'records'
						? input.items.error
						: false
			);
		if (blocks.data && !blocksFailed) {
			try {
				this.domain.acceptBlocks(
					blocks.data,
					input.kind === 'overlays' ? 'defer-to-overlays' : 'empty',
					materialized?.document
				);
			} catch {
				blocksFailed = true;
			}
		}
		if (input.kind === 'overlays') {
			try {
				this.domain.acceptOverlays(input.overlays, input.contract);
			} catch {
				itemsFailed = true;
			}
		} else if (input.kind === 'structure' && input.structure.data && !itemsFailed) {
			try {
				if (input.structure.data.ready)
					this.domain.acceptStructure(input.structure.data.items, input.pendingRenderKey, true);
				this.domain.acceptDetails(input.details ?? []);
			} catch {
				itemsFailed = true;
			}
		} else if (input.kind === 'records' && input.items.data && !itemsFailed) {
			try {
				this.domain.acceptItems(input.items.data, input.contract);
			} catch {
				itemsFailed = true;
			}
		}
		if (rollback && (blocksFailed || itemsFailed)) {
			rollback();
			this.itemsCurrent = false;
			this.issue = { blocksFailed, itemsFailed };
			return;
		}
		if (!blocksFailed && blocks.data) {
			if (this.materialized?.document !== materialized?.document) this.contentKey = '';
			this.materialized = materialized;
		}
		this.itemsCurrent =
			Boolean(
				input.kind === 'overlays'
					? true
					: input.kind === 'structure'
						? input.structure.data?.ready
						: input.items.data
			) && !itemsFailed;
		this.issue = blocksFailed || itemsFailed ? { blocksFailed, itemsFailed } : null;
		this.compiled = this.domain.document;
		this.geometry = this.domain.geometry;
		this.geometryVersion = this.geometry?.version ?? 0;
		this.items = this.domain.records;
		this.structuralItems = this.domain.structures;
		this.annotations = this.domain.overlays;
		this.contentOverlays = this.domain.contentOverlays;
		this.refreshContent();
	}
}
