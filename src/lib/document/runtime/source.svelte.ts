import { measureStartupWork, recordColdStart, recordDomainWork } from './render-perf';
import type { ContractBlock } from '$lib/contract/model';
import type { CompiledContract } from '$lib/contract/compiled-contract';
import type { PlaybookItemRecord } from '$lib/playbook/model';
import type { PlaybookGeometryIndex } from '$lib/playbook/geometry-index';
import { DocumentDomain } from '../domain/document-domain';
import type { ContractRenderSource, SourceIssue } from './types';
import type { StructureSnapshot, StructureItem } from '$lib/playbook/structure';
import type { ConcessionSelection } from '$lib/playbook/model';
import type { DocumentOverlayItem } from '$lib/playbook/document-overlay';
import { DocumentArtifacts } from './artifacts';

type QueryValue<T> = { data?: T; error?: unknown };
export interface ContractSourceInput {
	blocks: QueryValue<ContractBlock[]>;
	items: QueryValue<PlaybookItemRecord[]>;
	structure?: QueryValue<StructureSnapshot>;
	details?: readonly PlaybookItemRecord[];
	pendingRenderKey?: string;
}

/** Workspace-owned source semantics. Query failures retain accepted data. */
export class ContractSourceController {
	itemsCurrent = $state(false);
	compactStructure = $state(false);
	items = $state.raw<readonly PlaybookItemRecord[] | null>(null);
	structuralItems = $state.raw<readonly StructureItem[] | null>(null);
	annotations = $state.raw<readonly DocumentOverlayItem[]>([]);
	contentOverlays = $state.raw<readonly DocumentOverlayItem[]>([]);
	compiled = $state.raw<CompiledContract | null>(null);
	geometry = $state.raw<PlaybookGeometryIndex | null>(null);
	geometryVersion = $state(0);
	renderSource = $state.raw<ContractRenderSource | null>(null);
	issue = $state.raw<SourceIssue | null>(null);
	private selection: ConcessionSelection = {};
	private contentKey = '';
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
		if (this.renderSource?.sourceIndex === this.compiled.index && key === this.contentKey) return;
		this.contentKey = key;
		if (this.artifacts?.source.sourceIndex !== this.compiled.index) {
			this.artifacts?.destroy();
			this.artifacts = undefined;
		}
		const source: ContractRenderSource = Object.freeze({
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

	accept(input: ContractSourceInput) {
		const startedAt = performance.now();
		try {
			measureStartupWork('sourceAccept', () => this.#accept(input));
		} finally {
			recordColdStart('source-accepted', startedAt);
			recordDomainWork(this.domain);
		}
	}

	#accept(input: ContractSourceInput) {
		this.compactStructure = Boolean(input.structure);
		let blocksFailed = Boolean(input.blocks.error),
			itemsFailed = Boolean(input.structure ? input.structure.error : input.items.error);
		if (input.blocks.data && !blocksFailed) {
			try {
				this.domain.acceptBlocks(input.blocks.data);
			} catch {
				blocksFailed = true;
			}
		}
		if (input.structure?.data && !itemsFailed) {
			try {
				if (input.structure.data.ready)
					this.domain.acceptStructure(input.structure.data.items, input.pendingRenderKey, true);
				this.domain.acceptDetails(input.details ?? []);
			} catch {
				itemsFailed = true;
			}
		} else if (!input.structure && input.items.data && !itemsFailed) {
			try {
				this.domain.acceptItems(input.items.data);
			} catch {
				itemsFailed = true;
			}
		}
		this.itemsCurrent =
			Boolean(input.structure ? input.structure.data?.ready : input.items.data) && !itemsFailed;
		this.issue = blocksFailed || itemsFailed ? { blocksFailed, itemsFailed } : null;
		this.compiled = this.domain.contract;
		this.geometry = this.domain.geometry;
		this.geometryVersion = this.geometry?.version ?? 0;
		this.items = this.domain.records;
		this.structuralItems = this.domain.structures;
		this.annotations = this.domain.overlays;
		this.contentOverlays = this.domain.contentOverlays;
		this.refreshContent();
	}
}
