import { CompiledContract } from '../../contract/compiled-contract';
import type { ContractBlock } from '../../contract/model';
import { immutable } from '../../immutable';
import { toDocumentOverlay, type DocumentOverlayItem } from '../../playbook/document-overlay';
import { playbookGeometryKey } from '../../playbook/geometry';
import { PlaybookGeometryIndex } from '../../playbook/geometry-index';
import type { PlaybookItemRecord } from '../../playbook/model';

import { documentAnnotations } from '../../playbook/document-overlay';
import { itemStructure, structureGeometry, type StructureItem } from '../../playbook/structure';

type StructuralEntry = {
	item: StructureItem;
	key: string;
	overlay: DocumentOverlayItem;
	geometryKey: string;
};

/** Workspace-owned semantics. Annotations and hydrated content have independent identities. */
export class DocumentDomain {
	contract: CompiledContract | null = null;
	geometry: PlaybookGeometryIndex | null = null;
	records: readonly PlaybookItemRecord[] | null = null;
	structures: readonly StructureItem[] | null = null;
	overlays: readonly DocumentOverlayItem[] = [];
	contentOverlays: readonly DocumentOverlayItem[] = [];
	readonly metrics = {
		compiledContractBuilds: 0,
		snapshotsAccepted: 0,
		recordsCompared: 0,
		recordsRecompiled: 0,
		recordsReused: 0,
		overlaysProjected: 0,
		overlaysReused: 0
	};
	private structureInput: {
		items: readonly StructureItem[];
		pendingRenderKey: string | undefined;
		contract: CompiledContract | null;
		certified: boolean;
	} | null = null;
	private baselineKey = '';
	private baselineInput: readonly ContractBlock[] | null = null;
	private accepted = new Map<
		string,
		{ record: PlaybookItemRecord; identity: string; overlay: DocumentOverlayItem; key: string }
	>();
	private structural = new Map<string, StructuralEntry>();
	lookup(id: string) {
		const entry = this.accepted.get(id),
			structure = this.structural.get(id);
		return entry && structure
			? { record: entry.record, annotations: structure.overlay.annotations }
			: null;
	}
	acceptBlocks(blocks: readonly ContractBlock[]) {
		if (blocks === this.baselineInput) return;
		const key = JSON.stringify(blocks);
		this.baselineInput = blocks;
		if (key === this.baselineKey) return;
		const contract = new CompiledContract(JSON.parse(key));
		const geometry = new PlaybookGeometryIndex(contract);
		this.contract = contract;
		this.geometry = geometry;
		this.baselineKey = key;
		this.metrics.compiledContractBuilds++;
	}
	acceptStructure(items: readonly StructureItem[], pendingRenderKey?: string, certified = false) {
		const previousInput = this.structureInput;
		if (
			previousInput?.items === items &&
			previousInput.pendingRenderKey === pendingRenderKey &&
			previousInput.contract === this.contract &&
			previousInput.certified === certified
		)
			return;
		// A failed new acceptance must not reuse an older success over partially changed state.
		this.structureInput = null;
		const next = new Map<string, StructuralEntry>();
		let geometryChanged = this.geometry?.items.size !== items.length;
		for (const item of items) {
			if (next.has(item._id)) throw new Error(`Duplicate Playbook Item ID: ${item._id}`);
			const pending = item.renderKey === pendingRenderKey;
			// Revisions and wording cannot change annotation identity or geometry.
			const key = JSON.stringify([
				item._id,
				item.renderKey,
				item.trigger,
				item.concessions,
				pending
			]);
			const previous = this.structural.get(item._id);
			if (previous?.key === key) {
				if (!this.geometry?.items.has(item._id)) {
					geometryChanged = true;
					if (!certified) this.geometry?.set(item._id, structureGeometry(item));
				}
				next.set(item._id, previous);
				continue;
			}
			const geometry = structureGeometry(item);
			const overlay: DocumentOverlayItem = {
				itemId: item._id,
				trigger: item.trigger,
				concessions: geometry.concessions,
				annotations: documentAnnotations(item).map((annotation) =>
					pending ? { ...annotation, pending: true } : annotation
				)
			};
			const geometryKey = playbookGeometryKey(overlay);
			if (previous?.geometryKey !== geometryKey || !this.geometry?.items.has(item._id)) {
				geometryChanged = true;
				if (!certified) this.geometry?.set(item._id, geometry);
			}
			next.set(item._id, { item, key, overlay, geometryKey });
		}
		for (const id of this.structural.keys())
			if (!next.has(id)) {
				geometryChanged = true;
				if (!certified) this.geometry?.remove(id);
			}
		if (certified && geometryChanged && this.contract) {
			const geometry = new PlaybookGeometryIndex(this.contract);
			geometry.loadCertified(
				[...next].map(([id, { item }]) => [id, structureGeometry(item)] as const)
			);
			this.geometry = geometry;
		} else if (!certified) this.geometry?.refreshValidation();
		const overlays = [...next.values()].map(({ overlay }) => overlay);
		if (
			overlays.length !== this.overlays.length ||
			overlays.some((item, i) => item !== this.overlays[i])
		)
			this.overlays = overlays;
		this.structures = items;
		this.structural = next;
		this.structureInput = { items, pendingRenderKey, contract: this.contract, certified };
	}
	acceptItems(records: readonly PlaybookItemRecord[]) {
		this.acceptStructure(records.map((record) => itemStructure(record)));
		this.acceptDetails(records);
	}
	acceptDetails(records: readonly PlaybookItemRecord[]) {
		this.metrics.snapshotsAccepted++;
		const next = new Map<string, typeof this.accepted extends Map<string, infer T> ? T : never>();
		for (const record of records) {
			this.metrics.recordsCompared++;
			const identity = JSON.stringify([record._creationTime, record.contentRevision]);
			const previous = this.accepted.get(record._id);
			if (previous?.identity === identity) {
				next.set(record._id, previous);
				this.metrics.recordsReused++;
				this.metrics.overlaysReused++;
				continue;
			}
			const copy = immutable(JSON.parse(JSON.stringify(record))) as PlaybookItemRecord;
			const projected = { ...toDocumentOverlay(copy), annotations: [] };
			const key = JSON.stringify(projected);
			next.set(record._id, {
				record: copy,
				identity,
				key,
				overlay: previous?.key === key ? previous.overlay : projected
			});
			this.metrics.recordsRecompiled++;
			this.metrics.overlaysProjected++;
		}
		const values = [...next.values()];
		if (
			!this.records ||
			values.length !== this.records.length ||
			values.some(({ record }, i) => record !== this.records![i])
		)
			this.records = values.map(({ record }) => record);
		const overlays = values.map(({ overlay }) => overlay);
		if (
			overlays.length !== this.contentOverlays.length ||
			overlays.some((overlay, i) => overlay !== this.contentOverlays[i])
		)
			this.contentOverlays = overlays;
		this.accepted = next;
	}
}
