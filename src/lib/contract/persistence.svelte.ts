import { sameSelection } from '$lib/playbook/model';
import { selectionLifecycles } from './approval';
import { MAX_SELECTED_CONCESSIONS } from './selection-limits';
import {
	saveError,
	type ContractSaveResult,
	type ContractState,
	type SavedSelections
} from './saved';
import type { Id } from '../../convex/_generated/dataModel';
import type { ContractDraft } from './draft-recovery.svelte';

export type ContractSaveRequest = {
	id: Id<'savedContracts'>;
	selectedConcessions: SavedSelections;
	selectionLifecycles: Record<string, string>;
	expectedRevision: number;
	operationId: string;
};

/** Owns persistence only. Document rendering never initiates a save. */
export class ContractPersistence {
	confirmed: ContractState;
	choices = $state.raw<SavedSelections>({});
	lifecycles = $state.raw<Record<string, string>>({});
	request = $state.raw<ContractSaveRequest | null>(null);
	error = $state<string | null>(null);
	selectionLimitError = $state<string | null>(null);
	conflict = $state(false);
	deleted = $state(false);
	recoveryPending = $state(false);
	private running = $state.raw<Promise<void> | null>(null);
	inFlight = $derived(this.running !== null);
	private active = $state(true);
	private paused = $state(false);
	private frozen = $state(false);
	private loadingLatest = $state(false);
	private transportGeneration = 0;
	private recovery: ContractDraft | null;
	private confirmedLifecycles = $derived.by(() =>
		selectionLifecycles(this.confirmed, this.required)
	);

	constructor(
		private id: Id<'savedContracts'>,
		initial: ContractState,
		private save: (request: ContractSaveRequest) => Promise<ContractSaveResult>,
		private checkpoint: (draft: ContractDraft | null) => void = () => {},
		recovery: ContractDraft | null = null,
		private required: ReadonlySet<string> = new Set()
	) {
		this.confirmed = $state.raw(initial);
		this.choices = { ...initial.selectedConcessions };
		this.lifecycles = selectionLifecycles(initial, this.required);
		this.recovery = recovery;
		this.recoveryPending = !!recovery;
		if (recovery) this.restoreChoices(recovery);
	}
	private restoreChoices(draft: ContractDraft) {
		this.choices = { ...draft.choices };
		this.lifecycles = { ...draft.lifecycles };
	}
	private useConfirmedChoices() {
		if (!sameSelection(this.choices, this.confirmed.selectedConcessions))
			this.choices = { ...this.confirmed.selectedConcessions };
		const lifecycles = this.confirmedLifecycles;
		if (!sameSelection(this.lifecycles, lifecycles)) this.lifecycles = lifecycles;
	}

	get pending() {
		return (
			this.recoveryPending ||
			this.conflict ||
			Boolean(this.request) ||
			!sameSelection(this.choices, this.confirmed.selectedConcessions) ||
			(this.required.size > 0 && !sameSelection(this.lifecycles, this.confirmedLifecycles))
		);
	}
	get editable() {
		return this.canSave && !this.frozen;
	}
	private get canSave() {
		return (
			this.active &&
			!this.paused &&
			!this.loadingLatest &&
			!this.conflict &&
			!this.deleted &&
			!this.recoveryPending
		);
	}
	private record() {
		if (this.recoveryPending) return;
		this.checkpoint(
			this.deleted || !this.pending
				? null
				: {
						version: 2,
						base: this.confirmed,
						choices: this.choices,
						lifecycles: this.lifecycles,
						request: this.request,
						conflict: this.conflict
					}
		);
	}

	select(itemId: Id<'playbookItems'>, concessionId: string | null) {
		if (!this.editable) return;
		const next = { ...this.choices };
		if (concessionId === null || next[itemId] === concessionId) delete next[itemId];
		else {
			if (!Object.hasOwn(next, itemId) && Object.keys(next).length >= MAX_SELECTED_CONCESSIONS) {
				this.showSelectionLimit();
				return;
			}
			next[itemId] = concessionId;
		}
		this.selectionLimitError = null;
		if (sameSelection(next, this.choices)) return;
		if (this.required.has(itemId)) {
			const lives = { ...this.lifecycles };
			if (next[itemId]) lives[itemId] = crypto.randomUUID();
			else delete lives[itemId];
			this.lifecycles = lives;
		}
		this.choices = next;
		this.record();
		this.start();
	}

	accept(next: ContractState | null) {
		if (!this.active || this.deleted) return;
		if (next === null) {
			this.deleted = true;
			this.recoveryPending = false;
			this.recovery = null;
			this.record();
			return;
		}
		if (this.recoveryPending) {
			this.restore(next);
			return;
		}
		if (next.revision < this.confirmed.revision) return;
		const pending = this.pending;
		const own = Boolean(this.request && next.lastOperationId === this.request.operationId);
		if (next.revision > this.confirmed.revision && pending && !own) this.conflict = true;
		this.confirmed = next;
		if (!pending && !this.conflict) this.useConfirmedChoices();
		// A subscription can confirm an ambiguous failed response. Do not send a duplicate.
		if (own && !this.running && !this.conflict) {
			this.request = null;
			this.error = null;
			this.start();
		}
		this.record();
	}
	private restore(next: ContractState) {
		const draft = this.recovery!;
		this.recovery = null;
		this.recoveryPending = false;
		this.confirmed = next;
		this.restoreChoices(draft);
		this.request = draft.request;
		this.conflict = draft.conflict;
		if (draft.request && next.lastOperationId === draft.request.operationId) {
			// The interrupted operation committed; only newer local choices remain.
			this.request = null;
		} else if (draft.request) {
			// Equality of the latest choices is not an acknowledgement of this request.
			// Replay its immutable arguments before saving any newer intent.
			if (next.revision !== draft.request.expectedRevision) this.conflict = true;
		} else if (
			next.revision !== draft.base.revision &&
			(!sameSelection(this.choices, next.selectedConcessions) ||
				!sameSelection(this.lifecycles, selectionLifecycles(next, this.required)))
		)
			this.conflict = true;
		this.record();
		this.start();
	}
	applyRecovered() {
		if (
			!this.active ||
			this.frozen ||
			!this.conflict ||
			this.deleted ||
			this.running ||
			this.recoveryPending ||
			this.loadingLatest
		)
			return;
		this.request = null;
		this.conflict = false;
		this.error = null;
		this.record();
		this.start();
	}

	private start() {
		if (!this.canSave || this.running || this.error) return;
		if (!this.request) {
			if (!this.pending) return;
			if (Object.keys(this.choices).length > MAX_SELECTED_CONCESSIONS) {
				this.showSelectionLimit();
				return;
			}
			this.selectionLimitError = null;
			this.request = {
				id: this.id,
				selectedConcessions: { ...this.choices },
				selectionLifecycles: { ...this.lifecycles },
				expectedRevision: this.confirmed.revision,
				operationId: crypto.randomUUID()
			};
		}
		const request = this.request;
		this.record();
		// Keep exactly one immutable operation until it is acknowledged or explicitly discarded.
		this.running = this.send(request, this.transportGeneration);
	}

	private showSelectionLimit() {
		this.selectionLimitError = `You can select up to ${MAX_SELECTED_CONCESSIONS.toLocaleString('en-US')} concessions. Remove a selection before adding another.`;
	}

	private async send(request: ContractSaveRequest, generation: number) {
		// Yield so `running` is assigned even if the transport throws synchronously.
		await Promise.resolve();
		if (!this.active || generation !== this.transportGeneration || this.paused) {
			if (generation === this.transportGeneration) {
				this.running = null;
			}
			return;
		}
		try {
			const result = await this.save(request);
			if (!this.active || generation !== this.transportGeneration) return;
			if (result.status === 'deleted') this.accept(null);
			else {
				// A subscription may already include a later rename at the same revision.
				if (result.state.revision > this.confirmed.revision) this.accept(result.state);
				if (result.status === 'conflict') this.conflict = true;
			}
			this.request = null;
		} catch (cause) {
			if (!this.active || generation !== this.transportGeneration) return;
			if (this.confirmed.lastOperationId === request.operationId) this.request = null;
			else
				this.error = saveError(
					cause,
					'We couldn’t save this contract. Your changes are still here.'
				);
		} finally {
			if (generation === this.transportGeneration) {
				this.running = null;
				this.record();
				if (this.active) this.start();
			}
		}
	}

	retry() {
		if (!this.canSave || this.running) return;
		this.error = null;
		this.start();
	}

	async loadLatest() {
		// A request already handed to Convex cannot be cancelled. Wait for its outcome
		// before discarding intent so a late acknowledgement cannot start another save.
		if (!this.active || this.frozen || this.deleted || this.recoveryPending || this.loadingLatest)
			return false;
		const generation = this.transportGeneration;
		this.loadingLatest = true;
		try {
			if (this.running) await this.running;
			if (
				!this.active ||
				this.deleted ||
				generation !== this.transportGeneration ||
				this.recoveryPending ||
				(this.request && this.confirmed.revision <= this.request.expectedRevision)
			)
				return false;
			// A newer revision prevents the old request from changing the server again.
			this.request = null;
			this.error = null;
			this.conflict = false;
			this.selectionLimitError = null;
			this.useConfirmedChoices();
			this.record();
			return true;
		} finally {
			this.loadingLatest = false;
			this.start();
		}
	}
	freeze(frozen: boolean) {
		this.frozen = frozen;
	}
	/** An old client may have committed a request without delivering its response. */
	restartTransport() {
		this.transportGeneration++;
		this.running = null;
		this.error = null;
		if (this.pending && !this.recoveryPending) {
			this.recovery = {
				version: 2,
				base: this.confirmed,
				choices: this.choices,
				lifecycles: this.lifecycles,
				request: this.request,
				conflict: this.conflict
			};
			this.recoveryPending = true;
		}
	}
	discard() {
		this.transportGeneration++;
		this.running = null;
		this.recovery = null;
		this.recoveryPending = false;
		this.request = null;
		this.error = null;
		this.conflict = false;
		this.useConfirmedChoices();
		this.checkpoint(null);
	}

	pause() {
		this.paused = true;
	}

	resume() {
		this.paused = false;
		this.start();
	}

	async flush() {
		const generation = this.transportGeneration;
		while (this.active && !this.deleted && !this.conflict && !this.error && this.pending) {
			this.start();
			if (!this.running) return false;
			await this.running;
			if (generation !== this.transportGeneration) return false;
		}
		return (
			this.active &&
			!this.deleted &&
			!this.conflict &&
			!this.error &&
			!this.pending &&
			!this.recoveryPending
		);
	}

	destroy() {
		this.active = false;
		this.transportGeneration++;
		this.running = null;
	}
}
