import { immutable } from '../../playbook/draft';
import { CompiledContract } from '../../contract/compiled-contract';
import type { ContractBlock } from '../../contract/model';
import type { PlaybookItemRecord } from '../../playbook/model';
import { toDocumentOverlay, type DocumentOverlayItem } from '../../playbook/document-overlay';
import { PlaybookGeometryIndex } from '../../playbook/geometry-index';
import { playbookGeometryKey } from '../../playbook/geometry';

interface AcceptedItem {
	record: PlaybookItemRecord;
	identity: string;
	overlay: DocumentOverlayItem;
	overlayKey: string;
	geometryKey: string;
}
/** Every content write advances the stored revision, including seeded records. */
function recordIdentity(record: PlaybookItemRecord): string {
	return JSON.stringify([record._creationTime, record.revision]);
}
/** Workspace-owned pure semantics; no renderer, reactive effects, native objects, or view intent. */
export class DocumentDomain {
	contract: CompiledContract | null = null;
	geometry: PlaybookGeometryIndex | null = null;
	records: readonly PlaybookItemRecord[] | null = null;
	overlays: readonly DocumentOverlayItem[] = [];
	renderRevision = 0;
	readonly metrics = {
		compiledContractBuilds: 0,
		snapshotsAccepted: 0,
		recordsCompared: 0,
		recordsRecompiled: 0,
		recordsReused: 0,
		overlaysProjected: 0,
		overlaysReused: 0
	};
	private baselineKey = '';
	private accepted = new Map<string, AcceptedItem>();
	/** Read the retained record and annotation projection without rebuilding either. */
	lookup(id: string) {
		const entry = this.accepted.get(id);
		return entry ? { record: entry.record, annotations: entry.overlay.annotations } : null;
	}
	acceptBlocks(blocks: readonly ContractBlock[]) {
		const key = JSON.stringify(blocks);
		if (key === this.baselineKey) return;
		const contract = new CompiledContract(JSON.parse(key));
		const geometry = new PlaybookGeometryIndex(contract);
		for (const [id, entry] of this.accepted) geometry.set(id, entry.record);
		geometry.refreshValidation();
		this.contract = contract;
		this.geometry = geometry;
		this.baselineKey = key;
		this.metrics.compiledContractBuilds++;
		this.renderRevision++;
	}

	acceptItems(records: readonly PlaybookItemRecord[]) {
		this.metrics.snapshotsAccepted++;
		const next = new Map<string, AcceptedItem>();
		const changed = new Set<string>();
		// Prepare every changed record before publishing or mutating the accepted index.
		for (const record of records) {
			if (next.has(record._id)) throw new Error(`Duplicate Playbook Item ID: ${record._id}`);
			this.metrics.recordsCompared++;
			const identity = recordIdentity(record),
				previous = this.accepted.get(record._id);
			if (previous?.identity === identity) {
				next.set(record._id, previous);
				this.metrics.recordsReused++;
				this.metrics.overlaysReused++;
				continue;
			}
			const copy: PlaybookItemRecord = immutable(JSON.parse(JSON.stringify(record)));
			const projected = toDocumentOverlay(copy);
			const overlayKey = JSON.stringify(projected);
			const overlay = previous?.overlayKey === overlayKey ? previous.overlay : projected;
			next.set(record._id, {
				record: copy,
				identity,
				overlay,
				overlayKey,
				geometryKey: playbookGeometryKey(overlay)
			});
			changed.add(record._id);
			this.metrics.recordsRecompiled++;
			this.metrics.overlaysProjected++;
		}
		for (const id of this.accepted.keys()) if (!next.has(id)) changed.add(id);
		for (const id of changed) {
			const previous = this.accepted.get(id),
				current = next.get(id);
			if (previous?.geometryKey !== current?.geometryKey) {
				if (current) this.geometry?.set(id, current.record);
				else this.geometry?.remove(id);
			} else if (current) this.geometry?.updateContent(id, current.record);
		}
		this.geometry?.refreshValidation();
		const overlays = [...next.values()].map((entry) => entry.overlay);
		const renderOverlayChanged =
			overlays.length !== this.overlays.length ||
			overlays.some((overlay, i) => overlay !== this.overlays[i]);
		if (renderOverlayChanged) {
			this.overlays = overlays;
			this.renderRevision++;
		}
		if (
			!this.records ||
			changed.size ||
			records.some((record, i) => record._id !== this.records?.[i]?._id)
		)
			this.records = [...next.values()].map((entry) => entry.record);
		this.accepted = next;
	}
}
