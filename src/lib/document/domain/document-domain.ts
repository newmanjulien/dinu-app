import type { ContractItemId } from '$lib/contract/item-identity';
import { CompiledDocument } from '../compiled-document';
import type { SourceBlock } from '../model';
import { immutable, type DeepReadonly } from '../../immutable';
import {
	toDocumentOverlay,
	type DocumentAnnotationItem,
	type DocumentOverlayItem
} from '../../playbook/document-overlay';
import { playbookGeometryKey } from '../../playbook/geometry';
import { PlaybookGeometryIndex } from '../../playbook/geometry-index';
import type { ContractItemRecord } from '../../playbook/model';
import { semanticPlaybookDraft } from '../../playbook/content';

import { documentAnnotations } from '../../playbook/document-overlay';
import {
	validateChangeReferences,
	validateStructuralReplacementContent
} from '../../playbook/validation';
import { itemStructure, playbookStructure, type StructureItem } from '../../playbook/structure';

type StructuralEntry = {
	item: DeepReadonly<StructureItem<ContractItemId>>;
	key: string;
	overlay: DocumentAnnotationItem;
	geometryKey: string;
};

/** Workspace-owned semantics. Annotations and hydrated content have independent identities. */
export class DocumentDomain {
	document: CompiledDocument | null = null;
	geometry: PlaybookGeometryIndex | null = null;
	records: DeepReadonly<ContractItemRecord[]> | null = null;
	structures: DeepReadonly<StructureItem<ContractItemId>[]> | null = null;
	overlays: readonly DocumentAnnotationItem[] = [];
	contentOverlays: readonly DocumentOverlayItem[] = [];
	readonly metrics = {
		compiledDocumentBuilds: 0,
		snapshotsAccepted: 0,
		recordsCompared: 0,
		recordsRecompiled: 0,
		recordsReused: 0,
		overlaysProjected: 0,
		overlaysReused: 0
	};
	private structureInput: {
		items: DeepReadonly<StructureItem<ContractItemId>[]>;
		pendingRenderKey: string | undefined;
		document: CompiledDocument | null;
		certified: boolean;
	} | null = null;
	private sourceKey = '';
	private sourceInput: readonly SourceBlock[] | null = null;
	private accepted = new Map<
		string,
		{
			record: DeepReadonly<ContractItemRecord>;
			identity: string;
			overlay: DocumentOverlayItem;
			key: string;
		}
	>();
	private structural = new Map<string, StructuralEntry>();
	lookup(id: string) {
		const entry = this.accepted.get(id),
			structure = this.structural.get(id);
		return entry && structure
			? { record: entry.record, annotations: structure.overlay.annotations }
			: null;
	}
	acceptBlocks(
		blocks: readonly SourceBlock[],
		initialGeometry: 'empty' | 'defer-to-overlays' = 'empty'
	) {
		const key = blocks === this.sourceInput ? this.sourceKey : JSON.stringify(blocks);
		if (key !== this.sourceKey) {
			const document = new CompiledDocument(JSON.parse(key));
			const geometry = initialGeometry === 'empty' ? new PlaybookGeometryIndex(document) : null;
			this.document = document;
			// Deferred overlay acceptance must never use an index for the previous document.
			this.geometry = geometry;
			this.sourceKey = key;
			this.metrics.compiledDocumentBuilds++;
		} else if (initialGeometry === 'empty' && !this.geometry && this.document) {
			// Restore normal initialization after a failed deferred acceptance of these blocks.
			this.geometry = new PlaybookGeometryIndex(this.document);
		}
		this.sourceInput = blocks;
	}
	acceptStructure(
		items: DeepReadonly<StructureItem<ContractItemId>[]>,
		pendingRenderKey?: string,
		certified = false
	) {
		const previousInput = this.structureInput;
		if (
			previousInput?.items === items &&
			previousInput.pendingRenderKey === pendingRenderKey &&
			previousInput.document === this.document &&
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
					if (!certified) this.geometry?.set(item._id, item);
				}
				next.set(item._id, previous);
				continue;
			}
			const overlay: DocumentAnnotationItem = {
				itemId: item._id,
				annotations: documentAnnotations(item).map((annotation) =>
					pending ? { ...annotation, pending: true } : annotation
				)
			};
			const geometryKey = playbookGeometryKey(item);
			if (previous?.geometryKey !== geometryKey || !this.geometry?.items.has(item._id)) {
				geometryChanged = true;
				if (!certified) this.geometry?.set(item._id, item);
			}
			next.set(item._id, { item, key, overlay, geometryKey });
		}
		for (const id of this.structural.keys())
			if (!next.has(id)) {
				geometryChanged = true;
				if (!certified) this.geometry?.remove(id);
			}
		if (certified && geometryChanged && this.document) {
			const geometry = new PlaybookGeometryIndex(this.document);
			geometry.loadCertified([...next].map(([id, { item }]) => [id, item] as const));
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
		this.structureInput = { items, pendingRenderKey, document: this.document, certified };
	}
	/** Public content is already projected; never invent private authoring records. */
	acceptOverlays(overlays: readonly DocumentOverlayItem[], contract = false) {
		if (!this.document) throw new Error('Document blocks are required.');
		const geometry = new PlaybookGeometryIndex(this.document);
		const ids = new Set<string>();
		for (const overlay of overlays) {
			if (ids.has(overlay.itemId)) throw new Error('Duplicate clause.');
			ids.add(overlay.itemId);
			if (!contract) geometry.set(overlay.itemId, playbookStructure(overlay));
		}
		if (contract)
			geometry.loadCertified(overlays.map((o) => [o.itemId, playbookStructure(o)] as const));
		else geometry.auditGeometry();
		for (const overlay of overlays) {
			validateStructuralReplacementContent(overlay);
			validateChangeReferences(this.document, overlay);
		}
		this.geometry = geometry;
		this.structures = [];
		this.records = [];
		this.overlays = overlays;
		this.contentOverlays = overlays;
	}
	acceptItems(records: DeepReadonly<ContractItemRecord[]>, contract = false) {
		this.acceptStructure(
			records.map((record) => itemStructure(record)),
			undefined,
			contract
		);
		this.acceptDetails(records);
	}
	acceptDetails(records: DeepReadonly<ContractItemRecord[]>) {
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
			// Copy the domain tree explicitly so reactive query proxies are supported too.
			const copy = immutable({
				...record,
				...semanticPlaybookDraft(record),
				...(record.instructions !== undefined ? { instructions: { ...record.instructions } } : {})
			});
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
