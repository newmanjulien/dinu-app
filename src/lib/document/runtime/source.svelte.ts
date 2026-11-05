import { measureStartupWork, recordColdStart, recordDomainWork } from './render-perf';
import type { ContractBlock } from '$lib/contract/model';
import type { CompiledContract } from '$lib/contract/compiled-contract';
import type { PlaybookItemRecord } from '$lib/playbook/model';
import type { PlaybookGeometryIndex } from '$lib/playbook/geometry-index';
import { DocumentDomain } from '../domain/document-domain';
import type { ContractRenderSource, SourceIssue } from './types';

type QueryValue<T> = { data?: T; error?: unknown };
export interface ContractSourceInput {
	blocks: QueryValue<ContractBlock[]>;
	items: QueryValue<PlaybookItemRecord[]>;
}

/** Workspace-owned source semantics. Query failures retain accepted data. */
export class ContractSourceController {
	itemsCurrent = $state(false);
	items = $state.raw<readonly PlaybookItemRecord[] | null>(null);
	compiled = $state.raw<CompiledContract | null>(null);
	geometry = $state.raw<PlaybookGeometryIndex | null>(null);
	geometryVersion = $state(0);
	renderSource = $state.raw<ContractRenderSource | null>(null);
	issue = $state.raw<SourceIssue | null>(null);

	constructor(readonly domain = new DocumentDomain()) {}

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
		let blocksFailed = Boolean(input.blocks.error),
			itemsFailed = Boolean(input.items.error);
		if (input.blocks.data && !blocksFailed) {
			try {
				this.domain.acceptBlocks(input.blocks.data);
			} catch {
				blocksFailed = true;
			}
		}
		if (input.items.data && !itemsFailed) {
			try {
				this.domain.acceptItems(input.items.data);
			} catch {
				itemsFailed = true;
			}
		}
		this.itemsCurrent = Boolean(input.items.data) && !itemsFailed;
		this.issue = blocksFailed || itemsFailed ? { blocksFailed, itemsFailed } : null;
		this.compiled = this.domain.contract;
		this.geometry = this.domain.geometry;
		this.geometryVersion = this.geometry?.version ?? 0;
		this.items = this.domain.records;
		if (!this.compiled || !this.items || this.renderSource?.revision === this.domain.renderRevision)
			return;
		this.renderSource = Object.freeze({
			revision: this.domain.renderRevision,
			blocks: this.compiled.blocks,
			items: this.domain.overlays,
			sourceIndex: this.compiled.index
		});
	}
}
