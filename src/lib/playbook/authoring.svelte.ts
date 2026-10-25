import type { CompiledContract } from '../contract/compiled-contract';
import type { PlaybookGeometryIndex } from './geometry-index';
import type { Concession, PlaybookItem, PlaybookItemRecord } from './model';
import {
	editingPlaybookDraft,
	equalPlaybookDraft,
	semanticPlaybookDraft,
	type PlaybookDraft
} from './draft';
import { countStartupWork } from '../document/runtime/render-perf';
import {
	validatePlaybookItemContent,
	validateChangeReferences,
	validateNewConcessions,
	validateConcessionUpdate,
	PlaybookValidationError,
	MAX_PLAYBOOK_ITEMS,
	MAX_CONTRACT_BLOCKS
} from './validation';
import { GeometryError } from './geometry';
import { geometrySelectionIssue, selectionIssueMessage } from './source-picking';
import type { Operation, SaveTransport } from './save-transport';

type Phase =
	| { kind: 'editing' }
	| { kind: 'saving'; operation: Operation }
	| { kind: 'uncertain'; operation: Operation; message: string }
	| { kind: 'rejected'; message: string; snapshot: PlaybookItem | null }
	| { kind: 'conflict'; remote: PlaybookItemRecord }
	| { kind: 'missing' };
export class AuthoringDraft {
	draft: PlaybookDraft = $state()!;
	confirmed = $state.raw<PlaybookItemRecord | null>(null);
	// Raw phase state preserves the exact frozen operation object across retry.
	phase = $state.raw<Phase>({ kind: 'editing' });
	constructor(
		readonly key: string,
		draft: PlaybookDraft,
		confirmed: PlaybookItemRecord | null
	) {
		this.draft = draft;
		this.confirmed = confirmed;
	}
}
const revision = (record: PlaybookItemRecord | null) => (record ? record.revision : 0);

/** Frozen operations stay isolated from reactive drafts and are reused verbatim on retry. */
function immutable<T extends object>(value: T): T {
	for (const child of Object.values(value))
		if (child && typeof child === 'object') immutable(child);
	return Object.freeze(value);
}

/** One visible local transaction. Only Save and Delete send new operations. */
export class AuthoringSession {
	active = $state<AuthoringDraft | null>(null);
	completion = $state<{ kind: 'saved' | 'deleted'; at: number } | null>(null);
	private items = $state.raw<readonly PlaybookItemRecord[]>([]);
	private baseline = $state.raw<CompiledContract | null>(null);
	private geometryIndex = $state.raw<PlaybookGeometryIndex | null>(null);
	private geometryVersion = $state(0);
	private validateGeometry: ReturnType<PlaybookGeometryIndex['createDraftValidator']> | null = null;
	private running: Promise<boolean> | null = null;
	private transportGeneration = 0;
	constructor(private transport: SaveTransport | null) {}
	get dirty() {
		const entry = this.active;
		return Boolean(
			entry && (!entry.confirmed || !equalPlaybookDraft(entry.draft, entry.confirmed))
		);
	}
	get unresolved() {
		return this.active?.phase.kind === 'saving' || this.active?.phase.kind === 'uncertain';
	}
	get hasUnsavedWork() {
		return this.dirty || this.unresolved;
	}
	get canEdit() {
		return this.active?.phase.kind === 'editing' || this.active?.phase.kind === 'rejected';
	}
	get canCancel() {
		return Boolean(this.active) && !this.unresolved;
	}
	get canDelete() {
		return Boolean(this.active?.confirmed) && this.canEdit;
	}
	validation = $derived(
		this.active ? this.validate(this.active) : { reason: '', diagnostic: null }
	);
	get rejectionReason() {
		const entry = this.active;
		return entry?.phase.kind === 'rejected' &&
			(!entry.phase.snapshot || equalPlaybookDraft(entry.draft, entry.phase.snapshot))
			? entry.phase.message
			: '';
	}
	get canSave() {
		const entry = this.active;
		const rejected =
			entry?.phase.kind === 'rejected' &&
			entry.phase.snapshot &&
			equalPlaybookDraft(entry.draft, entry.phase.snapshot);
		return this.canEdit && this.dirty && !this.validation.reason && !rejected;
	}
	get statusMessage() {
		const phase = this.active?.phase;
		switch (phase?.kind) {
			case 'saving':
				return phase.operation.kind === 'delete' ? 'Deleting instruction box…' : 'Saving…';
			case 'uncertain':
				return `The ${phase.operation.kind === 'delete' ? 'deletion' : 'save'} is not confirmed. Retry to resolve it. ${phase.message}`;
			case 'rejected':
				return this.rejectionReason;
			case 'conflict':
				return 'This instruction box changed elsewhere. Your local edits are retained.';
			case 'missing':
				return 'This instruction box was deleted elsewhere. Cancel to dismiss your local draft.';
			default:
				return '';
		}
	}
	open(record: PlaybookItemRecord) {
		if (this.hasUnsavedWork) return false;
		this.begin(editingPlaybookDraft(record), record);
		return true;
	}
	start(draft: PlaybookDraft) {
		if (this.hasUnsavedWork) return false;
		this.begin(draft, null);
		return true;
	}
	private begin(draft: PlaybookDraft, confirmed: PlaybookItemRecord | null) {
		this.completion = null;
		this.active = new AuthoringDraft(crypto.randomUUID(), draft, confirmed);
	}
	save() {
		const entry = this.active;
		if (!entry || !this.canSave) return false;
		const operation: Operation = immutable({
			kind: 'save',
			request: {
				...(entry.confirmed ? { id: entry.confirmed._id } : {}),
				item: semanticPlaybookDraft(entry.draft),
				expectedRevision: revision(entry.confirmed),
				operationId: crypto.randomUUID()
			}
		});
		return this.run(entry, operation);
	}
	cancel() {
		if (!this.canCancel) return false;
		this.active = null;
		return true;
	}
	updateTargetReadiness(key: string): string {
		const entry = this.active;
		if (!entry || entry.key !== key || !entry.confirmed)
			return 'This instruction box is no longer available';
		if (!this.canEdit) return this.statusMessage;
		return '';
	}
	/** Validate only the staged concession, independently of unrelated parent edits. */
	additionReadiness(key: string, concession: Concession): string {
		const reason = this.updateTargetReadiness(key);
		if (reason) return reason;
		const entry = this.active!;
		const staged = { ...entry.draft, instructions: {}, concessions: [concession] };
		return this.validate({ key: entry.key, confirmed: null, phase: entry.phase, draft: staged })
			.reason;
	}
	/** Local edits may be invalid; Save validates the draft. */
	replaceDraft(key: string, draft: PlaybookDraft): string {
		const reason = this.updateTargetReadiness(key);
		if (reason) return reason;
		if (draft.persistedId !== this.active!.draft.persistedId)
			return 'This instruction box is no longer available';
		this.active!.draft = draft;
		return '';
	}
	retry() {
		const entry = this.active;
		return entry?.phase.kind === 'uncertain' ? this.run(entry, entry.phase.operation) : false;
	}
	remove() {
		const entry = this.active;
		if (!entry?.confirmed || !this.canDelete) return false;
		return this.run(
			entry,
			immutable({
				kind: 'delete',
				id: entry.confirmed._id,
				expectedRevision: revision(entry.confirmed)
			})
		);
	}
	useSaved() {
		const entry = this.active;
		if (entry?.phase.kind === 'conflict') this.adopt(entry, entry.phase.remote);
	}
	accept(
		contract: CompiledContract | null,
		geometry: PlaybookGeometryIndex | null,
		items: readonly PlaybookItemRecord[] | null
	) {
		countStartupWork('authoringAccept');
		if (!contract || !geometry || !items) return;
		if (this.geometryIndex !== geometry) this.validateGeometry = geometry.createDraftValidator();
		this.baseline = contract;
		this.geometryIndex = geometry;
		this.geometryVersion = geometry.version;
		this.items = items;
		if (this.active) this.reconcile(this.active);
	}
	private adopt(entry: AuthoringDraft, record: PlaybookItemRecord) {
		entry.confirmed = record;
		entry.draft = editingPlaybookDraft(record);
		entry.phase = { kind: 'editing' };
	}
	private reconcile(entry: AuthoringDraft, checkMissing = true) {
		if (this.unresolved || entry.phase.kind === 'missing') return;
		// A creation conflict identifies the saved record without adopting its content.
		const id =
			entry.confirmed?._id ?? (entry.phase.kind === 'conflict' ? entry.phase.remote._id : null);
		if (!id) return;
		const record = this.items.find((item) => item._id === id);
		if (!record) {
			if (checkMissing) entry.phase = { kind: 'missing' };
		} else if (entry.phase.kind === 'conflict') {
			if (revision(record) > revision(entry.phase.remote))
				entry.phase = { kind: 'conflict', remote: record };
		} else if (revision(record) > revision(entry.confirmed)) {
			if (this.dirty) entry.phase = { kind: 'conflict', remote: record };
			else this.adopt(entry, record);
		}
	}
	private validationMessage(diagnostic: unknown): string {
		if (diagnostic instanceof GeometryError)
			return selectionIssueMessage(geometrySelectionIssue(diagnostic));
		if (diagnostic instanceof PlaybookValidationError) return diagnostic.message;
		return "Couldn't validate these instructions. Please try again.";
	}
	private validate(job: AuthoringDraft): { reason: string; diagnostic: unknown } {
		if (!this.baseline || !this.geometryIndex || !this.validateGeometry)
			return { reason: 'Wait for the contract source', diagnostic: null };
		void this.geometryVersion;
		try {
			if (this.baseline.blocks.length > MAX_CONTRACT_BLOCKS)
				throw new PlaybookValidationError('Contract exceeds the supported source or Playbook size');
			const phase = job.phase;
			const creating =
				(phase.kind === 'saving' || phase.kind === 'uncertain') &&
				phase.operation.kind === 'save' &&
				!phase.operation.request.id;
			// Creation identity is not known until acknowledgment. Full server validation still applies.
			if (
				!creating &&
				this.items.length -
					(job.draft.persistedId && this.geometryIndex.items.has(job.draft.persistedId) ? 1 : 0) >=
					MAX_PLAYBOOK_ITEMS
			)
				throw new PlaybookValidationError('Playbook exceeds supported size');
			this.validateGeometry(job.draft.persistedId, job.draft, creating);
			if (job.confirmed) validateConcessionUpdate(job.confirmed, job.draft);
			else validateNewConcessions(job.draft.concessions);
			const item = semanticPlaybookDraft(job.draft);
			validatePlaybookItemContent(item);
			validateChangeReferences(this.baseline, item);
		} catch (error) {
			return { reason: this.validationMessage(error), diagnostic: error };
		}
		return { reason: '', diagnostic: null };
	}
	async flush() {
		const generation = this.transportGeneration;
		if (this.running) await this.running;
		return generation === this.transportGeneration && !this.hasUnsavedWork;
	}
	restartTransport() {
		this.transportGeneration++;
		this.running = null;
		const entry = this.active;
		if (entry?.phase.kind === 'saving')
			entry.phase = {
				kind: 'uncertain',
				operation: entry.phase.operation,
				message: 'The connection changed. Retry to confirm this operation.'
			};
	}
	discard() {
		this.transportGeneration++;
		this.running = null;
		this.active = null;
	}
	private run(entry: AuthoringDraft, operation: Operation) {
		const work = this.send(entry, operation, this.transportGeneration);
		this.running = work;
		void work.finally(() => {
			if (this.running === work) this.running = null;
		});
		return work;
	}
	private async send(entry: AuthoringDraft, operation: Operation, generation: number) {
		if (this.active !== entry || entry.phase.kind === 'saving') return false;
		this.completion = null;
		if (!this.transport) {
			entry.phase = {
				kind: 'rejected',
				message: 'Saving is unavailable: the backend is not configured.',
				snapshot: operation.kind === 'save' ? operation.request.item : null
			};
			return false;
		}
		entry.phase = { kind: 'saving', operation };
		try {
			const result = await this.transport(operation);
			if (this.active !== entry || generation !== this.transportGeneration) return false;
			switch (result.status) {
				case 'rejected':
					entry.phase = {
						kind: 'rejected',
						message: result.message,
						snapshot: operation.kind === 'save' ? operation.request.item : null
					};
					break;
				case 'conflict':
					entry.phase = { kind: 'conflict', remote: result.item };
					break;
				case 'missing':
					entry.phase = { kind: 'missing' };
					break;
				case 'deleted':
				case 'saved':
					this.active = null;
					this.completion = { kind: result.status, at: Date.now() };
					return true;
			}
			// Only a new creation may still be absent from the live query. An existing
			// record's observed deletion must take precedence over a conflict response.
			this.reconcile(entry, Boolean(entry.confirmed) || result.status !== 'conflict');
		} catch (error) {
			if (this.active !== entry || generation !== this.transportGeneration) return false;
			entry.phase = {
				kind: 'uncertain',
				operation,
				message: error instanceof Error ? error.message : 'Please retry.'
			};
		}
		return false;
	}
}
