import { ConvexError } from 'convex/values';
import type { Id } from '../../convex/_generated/dataModel';
import { MAX_SELECTED_CONCESSIONS } from '../document/selection-limits';
import { sameSelection } from '../playbook/model';
import { concessionSelectionMap } from './changes';
import type { ContractDraft, ContractSaveRequest } from './draft-values';
import {
	olderContractState,
	saveError,
	type ContractSaveResult,
	type ContractState,
	type LiveContractState
} from './saved';
import { workBlockFromError, workBlockMessage, type ContractWorkBlock } from './work-policy';

export type { ContractSaveRequest } from './draft-values';

export const CONTRACT_CHOICE_SAVE_DELAY_MS = 300;

type Resolution =
	| { kind: 'current' }
	| { kind: 'conflict'; message?: string }
	| { kind: 'failed'; message: string }
	| { kind: 'deleted' };

/** Flat selection persistence backed by single-transaction contracts.save mutations. */
export class ContractPersistence {
	confirmed: ContractState;
	private draftSelections = $state.raw<Record<string, string> | null>(null);
	private baseStateRevision: number;
	private stableChoices: Record<string, string> = {};
	choices = $derived.by(() => {
		const next = this.draftSelections
			? this.draftSelections
			: concessionSelectionMap(this.confirmed.concessions);
		if (!sameSelection(next, this.stableChoices)) this.stableChoices = next;
		return this.stableChoices;
	});
	request = $state.raw<ContractSaveRequest | null>(null);
	private policy = $state<ContractWorkBlock | null>(null);
	private policyRefused = false;
	private resolution = $state.raw<Resolution>({ kind: 'current' });
	selectionLimitError = $state<string | null>(null);
	private running = $state.raw<Promise<void> | null>(null);
	inFlight = $derived(this.running !== null);
	private active = $state(true);
	private paused = $state(false);
	private frozen = $state(false);
	private adoptingConfirmed = $state(false);
	private transportGeneration = 0;
	private transport = new AbortController();
	private recovery = $state.raw<ContractDraft | null>(null);
	private choiceSaveTimer: ReturnType<typeof setTimeout> | null = null;

	get workBlock() {
		return this.policy;
	}
	get blockedReason() {
		return this.policy ? workBlockMessage(this.policy) : null;
	}
	get error() {
		return 'message' in this.resolution ? (this.resolution.message ?? null) : null;
	}
	get conflict() {
		return this.resolution.kind === 'conflict';
	}
	get deleted() {
		return this.resolution.kind === 'deleted';
	}
	get recoveryPending() {
		return this.recovery !== null;
	}
	get pending() {
		return (
			this.recoveryPending ||
			this.conflict ||
			Boolean(this.request) ||
			this.draftSelections !== null
		);
	}
	get editable() {
		return this.canSave && !this.policy && !this.conflict && !this.frozen;
	}
	private get canSave() {
		return (
			this.active &&
			!this.paused &&
			!this.adoptingConfirmed &&
			(!this.conflict || Boolean(this.request)) &&
			!this.deleted &&
			!this.recoveryPending
		);
	}

	constructor(
		private id: Id<'savedContracts'>,
		initial: ContractState | LiveContractState,
		private save: (
			request: ContractSaveRequest,
			signal: AbortSignal
		) => Promise<ContractSaveResult>,
		private checkpoint: (draft: ContractDraft | null) => void = () => {},
		recovery: ContractDraft | null = null
	) {
		this.confirmed = $state.raw(initial);
		this.baseStateRevision = recovery?.baseStateRevision ?? initial.stateRevision;
		this.policy = 'workBlock' in initial ? (initial.workBlock ?? null) : null;
		this.recovery = recovery;
		if (recovery) this.draftSelections = { ...recovery.selections };
	}

	private clearError() {
		if (this.resolution.kind === 'failed') this.resolution = { kind: 'current' };
		else if (this.conflict) this.resolution = { kind: 'conflict' };
	}
	private fail(message: string) {
		this.resolution = this.conflict ? { kind: 'conflict', message } : { kind: 'failed', message };
	}
	private acceptPolicy(block: ContractWorkBlock | null) {
		if (block === this.policy) return;
		this.policy = block;
		if (this.policyRefused) this.clearError();
		this.policyRefused = false;
	}
	private record() {
		if (this.draftSelections === null) this.cancelChoiceSave();
		if (this.recoveryPending) return;
		this.checkpoint(
			this.deleted || !this.pending || !this.draftSelections
				? null
				: {
						version: 1,
						baseStateRevision: this.baseStateRevision,
						selections: { ...this.draftSelections },
						request: this.request,
						conflict: this.conflict
					}
		);
	}

	setOption(itemId: Id<'playbookItems'>, optionId: string | null) {
		if (!this.editable) return;
		const next: Record<string, string> = { ...this.choices };
		if (optionId === null) delete next[itemId];
		else next[itemId] = optionId;
		if (Object.keys(next).length > MAX_SELECTED_CONCESSIONS) {
			this.selectionLimitError = `You can select up to ${MAX_SELECTED_CONCESSIONS.toLocaleString('en-US')} Playbook options. Remove a selection before adding another.`;
			return;
		}
		this.selectionLimitError = null;
		if (sameSelection(next, this.choices) && !this.error) return;
		const confirmedMap = concessionSelectionMap(this.confirmed.concessions);
		if (sameSelection(next, confirmedMap) && !this.request) {
			this.draftSelections = null;
			this.baseStateRevision = this.confirmed.stateRevision;
			this.clearError();
			this.record();
			return;
		}
		if (this.draftSelections === null) this.baseStateRevision = this.confirmed.stateRevision;
		this.draftSelections = next;
		this.clearError();
		this.record();
		this.scheduleChoiceSave();
	}

	private cancelChoiceSave() {
		if (this.choiceSaveTimer === null) return;
		clearTimeout(this.choiceSaveTimer);
		this.choiceSaveTimer = null;
	}

	private scheduleChoiceSave() {
		this.cancelChoiceSave();
		this.choiceSaveTimer = setTimeout(() => {
			this.choiceSaveTimer = null;
			this.start();
		}, CONTRACT_CHOICE_SAVE_DELAY_MS);
	}

	acceptLive(next: LiveContractState | null) {
		if (!this.active || this.deleted) return;
		if (next) this.acceptPolicy(next.workBlock);
		this.accept(next);
	}

	accept(next: ContractState | null) {
		if (!this.active || this.deleted) return;
		if (next === null) {
			this.replaceTransport();
			this.request = null;
			this.resolution = { kind: 'deleted' };
			this.recovery = null;
			this.draftSelections = null;
			this.selectionLimitError = null;
			this.record();
			return;
		}
		if (olderContractState(next, this.confirmed)) return;
		if (this.recoveryPending) {
			this.restore(next);
			return;
		}
		const own =
			this.request && next.lastOperationId === this.request.operationId ? this.request : null;
		this.confirmed = next;
		if (own) {
			this.acknowledgeRequest(next);
			this.request = null;
			this.clearError();
		} else if (this.draftSelections !== null) {
			const confirmedMap = concessionSelectionMap(next.concessions);
			if (sameSelection(this.draftSelections, confirmedMap)) {
				this.draftSelections = null;
				this.baseStateRevision = next.stateRevision;
				this.request = null;
				this.resolution = { kind: 'current' };
			} else if (next.stateRevision > this.baseStateRevision && !this.request) {
				this.resolution = { kind: 'conflict', ...(this.error ? { message: this.error } : {}) };
			}
		} else {
			this.baseStateRevision = next.stateRevision;
		}
		this.record();
		this.start();
	}

	private restore(next: ContractState) {
		const draft = this.recovery!;
		this.recovery = null;
		this.confirmed = next;
		this.draftSelections = { ...draft.selections };
		this.baseStateRevision = draft.baseStateRevision;
		this.request = draft.request ? structuredClone(draft.request) : null;
		this.resolution = draft.conflict ? { kind: 'conflict' } : { kind: 'current' };
		const confirmedMap = concessionSelectionMap(next.concessions);
		if (this.request && next.lastOperationId === this.request.operationId) {
			this.acknowledgeRequest(next);
			this.request = null;
		} else if (sameSelection(this.draftSelections, confirmedMap)) {
			this.draftSelections = null;
			this.baseStateRevision = next.stateRevision;
			this.request = null;
			this.resolution = { kind: 'current' };
		} else if (next.stateRevision > this.baseStateRevision && !this.request) {
			this.resolution = { kind: 'conflict' };
		}
		this.record();
		this.start();
	}

	recoverDraft(draft: ContractDraft) {
		if (!this.active || this.pending || this.running) return false;
		this.recovery = draft;
		this.restore(this.confirmed);
		return true;
	}

	applyRecovered() {
		if (
			!this.active ||
			this.policy ||
			this.frozen ||
			!this.conflict ||
			this.request ||
			this.deleted ||
			this.running ||
			this.recoveryPending ||
			this.adoptingConfirmed
		)
			return;
		this.baseStateRevision = this.confirmed.stateRevision;
		this.resolution = { kind: 'current' };
		this.record();
		this.start(true);
	}

	private acknowledgeRequest(committed: ContractState) {
		this.baseStateRevision = committed.stateRevision;
		const confirmedMap = concessionSelectionMap(committed.concessions);
		if (this.draftSelections && sameSelection(this.draftSelections, confirmedMap)) {
			this.draftSelections = null;
		}
		this.resolution = { kind: 'current' };
	}

	private clearDraftToConfirmed() {
		this.draftSelections = null;
		this.baseStateRevision = this.confirmed.stateRevision;
		this.resolution = { kind: 'current' };
	}

	private adoptConfirmedIfMatching() {
		if (
			!this.draftSelections ||
			sameSelection(this.draftSelections, concessionSelectionMap(this.confirmed.concessions))
		) {
			this.clearDraftToConfirmed();
			return true;
		}
		return false;
	}

	private start(force = false) {
		if (force) this.cancelChoiceSave();
		else if (this.choiceSaveTimer !== null) return;
		if (
			!this.canSave ||
			this.running ||
			this.error ||
			this.policyRefused ||
			(this.policy && !this.request)
		)
			return;
		if (!this.request) {
			if (this.draftSelections === null) return;
			this.request = {
				id: this.id,
				operationId: crypto.randomUUID(),
				expectedStateRevision: this.baseStateRevision,
				selections: { ...this.draftSelections }
			};
		}
		const request = this.request;
		this.record();
		this.running = this.send(request, this.transportGeneration, this.transport.signal);
	}

	private async send(request: ContractSaveRequest, generation: number, signal: AbortSignal) {
		await Promise.resolve();
		if (!this.active || generation !== this.transportGeneration || this.paused) {
			if (generation === this.transportGeneration) this.running = null;
			return;
		}
		try {
			const result = await this.save(request, signal);
			if (
				!this.active ||
				generation !== this.transportGeneration ||
				this.request?.operationId !== request.operationId
			)
				return;
			if (result.status === 'deleted') {
				this.accept(null);
			} else {
				if (!olderContractState(result.state, this.confirmed)) this.confirmed = result.state;
				if (result.status === 'saved') {
					if (result.state.stateRevision < this.confirmed.stateRevision) {
						const replayedMap = concessionSelectionMap(result.state.concessions);
						if (!this.adoptConfirmedIfMatching()) {
							if (this.draftSelections && sameSelection(this.draftSelections, replayedMap)) {
								this.clearDraftToConfirmed();
							} else {
								this.resolution = { kind: 'conflict' };
							}
						}
					} else {
						this.acknowledgeRequest(result.state);
					}
				} else if (!this.adoptConfirmedIfMatching()) {
					this.resolution = { kind: 'conflict' };
				}
				this.request = null;
			}
		} catch (cause) {
			if (
				!this.active ||
				generation !== this.transportGeneration ||
				this.request?.operationId !== request.operationId
			)
				return;
			if (this.confirmed.lastOperationId === request.operationId) {
				this.acknowledgeRequest(this.confirmed);
				this.request = null;
			} else if (workBlockFromError(cause)) {
				this.request = null;
				this.policyRefused = true;
				this.fail(workBlockMessage(workBlockFromError(cause)!));
			} else if (cause instanceof ConvexError) {
				this.request = null;
				this.fail(saveError(cause, 'We couldn’t save this contract. Your changes are still here.'));
			} else {
				this.fail(saveError(cause, 'We couldn’t save this contract. Your changes are still here.'));
			}
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
		this.policyRefused = false;
		this.clearError();
		this.start(true);
	}

	async useConfirmedState() {
		if (
			!this.active ||
			this.frozen ||
			this.deleted ||
			this.recoveryPending ||
			this.adoptingConfirmed
		)
			return false;
		const generation = this.transportGeneration;
		this.adoptingConfirmed = true;
		try {
			if (this.running) await this.running;
			if (
				!this.active ||
				this.deleted ||
				generation !== this.transportGeneration ||
				this.recoveryPending ||
				this.request
			)
				return false;
			this.request = null;
			this.draftSelections = null;
			this.baseStateRevision = this.confirmed.stateRevision;
			this.resolution = { kind: 'current' };
			this.selectionLimitError = null;
			this.record();
			return true;
		} finally {
			this.adoptingConfirmed = false;
			this.start();
		}
	}

	freeze(frozen: boolean) {
		this.frozen = frozen;
	}
	private replaceTransport() {
		this.cancelChoiceSave();
		this.transportGeneration++;
		this.transport.abort();
		this.transport = new AbortController();
		this.running = null;
	}
	restartTransport() {
		if (this.deleted) return;
		this.replaceTransport();
		this.clearError();
		if (this.pending && !this.recoveryPending && this.draftSelections)
			this.recovery = {
				version: 1,
				baseStateRevision: this.baseStateRevision,
				selections: { ...this.draftSelections },
				request: this.request,
				conflict: this.conflict
			};
	}
	discard() {
		this.replaceTransport();
		this.recovery = null;
		this.request = null;
		this.draftSelections = null;
		this.baseStateRevision = this.confirmed.stateRevision;
		if (!this.deleted) this.resolution = { kind: 'current' };
		this.checkpoint(null);
	}
	pause() {
		this.paused = true;
	}
	resume() {
		this.paused = false;
		this.start();
	}
	async savePending() {
		const generation = this.transportGeneration;
		while (
			this.active &&
			!this.deleted &&
			!this.conflict &&
			!this.error &&
			(this.pending || this.running)
		) {
			this.start(true);
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
			!this.running &&
			!this.recoveryPending
		);
	}
	destroy() {
		this.active = false;
		this.replaceTransport();
	}
}
