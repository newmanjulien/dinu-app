import type { Id } from '../../convex/_generated/dataModel';
import {
	choicesOf,
	concessionSelections,
	sameApplications,
	type ApplicationChoices
} from './applications';
import { projectCommands, MAX_ACTIVITY_COMMANDS, type ActivityCommand } from './activity-commands';
import type { ContractDraft } from './draft-recovery.svelte';
import {
	olderContractState,
	saveError,
	type ContractSaveResult,
	type ContractState
} from './saved';
import { MAX_SELECTED_CONCESSIONS } from './selection-limits';
import {
	workBlockFromError,
	workBlockMessage,
	errorCode,
	type ContractWorkBlock
} from './work-policy';

export type ContractSaveRequest = {
	id: Id<'savedContracts'>;
	choices: ApplicationChoices;
	commands: ActivityCommand[];
	expectedEditRevision: number;
	operationId: string;
};

// Immutable snapshot requests are retained only for pre-command journal recovery.
export type RetainedSaveRequest = Omit<ContractSaveRequest, 'commands'> & {
	commands?: ActivityCommand[];
};

/** Owns persistence only. Document rendering never initiates a save. */
type Resolution =
	| { kind: 'current' }
	| { kind: 'conflict'; message?: string }
	| { kind: 'failed'; message: string }
	| { kind: 'deleted' };

export class ContractPersistence {
	confirmed: ContractState;
	private commands = $state.raw<ActivityCommand[]>([]);
	intent = $state.raw<ApplicationChoices>({});
	/** A rendering projection; approval identity lives in intent. */
	choices = $derived(concessionSelections(this.intent));
	request = $state.raw<RetainedSaveRequest | null>(null);
	private policy = $state<ContractWorkBlock | null>(null);
	private policyRefused = false;
	private legacyRejected = false;
	private legacyIntent = false;
	get workBlock() {
		return this.policy;
	}
	blockWork(block: ContractWorkBlock) {
		this.acceptPolicy(block);
	}
	get blockedReason() {
		return this.policy ? workBlockMessage(this.policy) : null;
	}
	private acceptPolicy(block: ContractWorkBlock | null) {
		if (block === this.policy) return;
		this.policy = block;
		this.policyRefused = false;
	}
	private resolution = $state.raw<Resolution>({ kind: 'current' });
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
	private clearError() {
		if (this.resolution.kind === 'failed') this.resolution = { kind: 'current' };
		else if (this.resolution.kind === 'conflict') this.resolution = { kind: 'conflict' };
	}
	private fail(message: string) {
		this.resolution = this.conflict ? { kind: 'conflict', message } : { kind: 'failed', message };
	}
	selectionLimitError = $state<string | null>(null);
	private running = $state.raw<Promise<void> | null>(null);
	inFlight = $derived(this.running !== null);
	private active = $state(true);
	private paused = $state(false);
	private frozen = $state(false);
	private adoptingConfirmed = $state(false);
	private transportGeneration = 0;
	private recovery = $state.raw<ContractDraft | null>(null);
	private confirmedChoices = $derived.by(() => choicesOf(this.confirmed.applications));

	constructor(
		private id: Id<'savedContracts'>,
		initial: ContractState,
		private save: (request: RetainedSaveRequest) => Promise<ContractSaveResult>,
		private checkpoint: (draft: ContractDraft | null) => void = () => {},
		recovery: ContractDraft | null = null,
		private required: ReadonlySet<string> = new Set()
	) {
		this.confirmed = $state.raw(initial);
		this.acceptPolicy(
			initial.workBlock !== undefined
				? initial.workBlock
				: initial.hubspot?.availability === 'unavailable'
					? 'deal-unavailable'
					: null
		);
		this.intent = choicesOf(initial.applications);
		this.recovery = recovery;
		if (recovery) this.restoreChoices(recovery);
	}
	private restoreChoices(draft: ContractDraft) {
		this.intent = { ...draft.intent };
		this.commands = draft.commands ?? [];
		// Old snapshot drafts may contain more intent than the bounded command queue.
		this.legacyIntent =
			draft.version !== 6 &&
			!sameApplications(
				projectCommands(choicesOf(draft.base.applications), this.commands),
				draft.intent
			);
	}
	private useConfirmedChoices() {
		if (!sameApplications(this.intent, this.confirmedChoices))
			this.intent = { ...this.confirmedChoices };
	}

	get pending() {
		return (
			this.recoveryPending ||
			this.conflict ||
			Boolean(this.request) ||
			this.commands.length > 0 ||
			!sameApplications(this.intent, this.confirmedChoices)
		);
	}
	get editable() {
		return (
			this.canSave &&
			!this.policy &&
			!this.legacyIntent &&
			!this.conflict &&
			!this.frozen &&
			this.commands.length < MAX_ACTIVITY_COMMANDS
		);
	}
	private get canSave() {
		return (
			this.active &&
			!this.paused &&
			!this.adoptingConfirmed &&
			(!this.conflict || Boolean(this.request?.commands)) &&
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
						version: this.legacyIntent || (this.request && !this.request.commands) ? 5 : 6,
						commands: this.commands,
						base: this.confirmed,
						intent: this.intent,
						request: this.request,
						conflict: this.conflict
					}
		);
	}

	select(itemId: Id<'playbookItems'>, concessionId: string | null) {
		if (!this.editable) return;
		const next = { ...this.intent };
		if (concessionId === null || next[itemId]?.concessionId === concessionId) delete next[itemId];
		else {
			if (!Object.hasOwn(next, itemId) && Object.keys(next).length >= MAX_SELECTED_CONCESSIONS) {
				this.showSelectionLimit();
				return;
			}
			next[itemId] = {
				concessionId,
				...(this.required.has(itemId) ? { applicationId: crypto.randomUUID() } : {})
			};
		}
		this.selectionLimitError = null;
		if (sameApplications(next, this.intent)) return;
		this.commands = [
			...this.commands,
			{ id: crypto.randomUUID(), itemId, choice: next[itemId] ?? null, occurredAt: Date.now() }
		];
		this.intent = next;
		this.record();
		this.start();
	}

	accept(next: ContractState | null) {
		if (!this.active || this.deleted) return;
		if (next === null) {
			// Submitted mutations may still finish, but none can leave this terminal state.
			this.transportGeneration++;
			this.running = null;
			this.request = null;
			this.resolution = { kind: 'deleted' };
			this.recovery = null;
			this.selectionLimitError = null;
			this.useConfirmedChoices();
			this.record();
			return;
		}
		if (olderContractState(next, this.confirmed)) return;
		if (Object.hasOwn(next, 'workBlock')) this.acceptPolicy(next.workBlock ?? null);
		else if (next.hubspot?.availability === 'unavailable') this.acceptPolicy('deal-unavailable');
		if (this.recoveryPending) {
			this.restore(next);
			return;
		}
		const pending = this.pending;
		const own = Boolean(this.request && next.lastOperationId === this.request.operationId);
		if (next.editRevision > this.confirmed.editRevision && pending && !own)
			this.resolution = { kind: 'conflict', ...(this.error ? { message: this.error } : {}) };
		if (next.stateVersion !== this.confirmed.stateVersion || Object.hasOwn(next, 'workBlock'))
			this.confirmed = {
				...next,
				workBlock: Object.hasOwn(next, 'workBlock') ? next.workBlock : this.confirmed.workBlock
			};
		if (!pending && !this.conflict) this.useConfirmedChoices();
		// A subscription can confirm an ambiguous failed response. Do not send a duplicate.
		if (own && !this.running && !this.conflict) {
			this.acknowledgeCommands();
			this.request = null;
			this.clearError();
			this.start();
		}
		this.record();
		this.start();
	}
	private restore(next: ContractState) {
		const draft = this.recovery!;
		this.recovery = null;
		this.confirmed = next;
		this.restoreChoices(draft);
		this.request = draft.request;
		this.resolution = draft.conflict ? { kind: 'conflict' } : { kind: 'current' };
		if (draft.request && next.lastOperationId === draft.request.operationId) {
			// The interrupted operation committed; only newer local choices remain.
			this.acknowledgeCommands();
			this.request = null;
		} else if (draft.request) {
			// Equality of the latest choices is not an acknowledgement of this request.
			// Replay its immutable arguments before saving any newer intent.
			if (next.editRevision !== draft.request.expectedEditRevision)
				this.resolution = { kind: 'conflict', ...(this.error ? { message: this.error } : {}) };
		} else if (
			next.editRevision !== draft.base.editRevision &&
			!sameApplications(this.intent, choicesOf(next.applications))
		)
			this.resolution = { kind: 'conflict', ...(this.error ? { message: this.error } : {}) };
		// Only genuinely unsubmitted old intent can become new commands automatically.
		if (!this.request && !this.conflict && !this.commands.length) this.stageIntent(this.intent);
		this.record();
		this.start();
	}
	private intentCommands(base: ApplicationChoices, intent: ApplicationChoices): ActivityCommand[] {
		const removals: ActivityCommand[] = [];
		const applications: ActivityCommand[] = [];
		for (const id of new Set([...Object.keys(base), ...Object.keys(intent)])) {
			const itemId = id as Id<'playbookItems'>;
			if (
				sameApplications(
					base[itemId] ? { [id]: base[itemId] } : {},
					intent[itemId] ? { [id]: intent[itemId] } : {}
				)
			)
				continue;
			const command = (choice: ActivityCommand['choice']): ActivityCommand => ({
				id: crypto.randomUUID(),
				itemId,
				choice,
				occurredAt: Date.now()
			});
			if (base[itemId]) removals.push(command(null));
			if (intent[itemId]) applications.push(command(intent[itemId]));
		}
		// Inferred transitions must free every old range before occupying final ranges.
		return [...removals, ...applications];
	}
	private stageIntent(target: ApplicationChoices) {
		const key = (command: ActivityCommand) =>
			`${command.choice ? 'apply' : 'remove'}:${command.itemId}`;
		const retained = new Map(this.commands.map((command) => [key(command), command]));
		const pending = this.intentCommands(this.confirmedChoices, target).map((command) => {
			const original = retained.get(key(command));
			return original &&
				sameApplications(
					original.choice ? { [command.itemId]: original.choice } : {},
					command.choice ? { [command.itemId]: command.choice } : {}
				)
				? original
				: command;
		});
		this.legacyIntent = pending.length > MAX_ACTIVITY_COMMANDS;
		this.commands = pending.slice(0, MAX_ACTIVITY_COMMANDS);
		this.intent = this.legacyIntent
			? target
			: projectCommands(this.confirmedChoices, this.commands);
	}
	applyRecovered() {
		if (
			!this.active ||
			this.policy ||
			this.frozen ||
			!this.conflict ||
			Boolean(this.request?.commands) ||
			this.deleted ||
			this.running ||
			this.recoveryPending ||
			this.adoptingConfirmed
		)
			return;
		// Reapplying an old draft must not replace reset review identities for
		// choices already present on the server. Different choices keep their identity.
		const intent = { ...this.intent };
		for (const [id, choice] of Object.entries(this.confirmedChoices)) {
			if (intent[id as Id<'playbookItems'>]?.concessionId === choice.concessionId)
				intent[id as Id<'playbookItems'>] = choice;
		}
		if (!this.commands.length || this.legacyIntent) this.stageIntent(intent);
		else {
			// Only the leading application epoch may already exist on the server.
			// Explicit removals or different concessions keep their fresh identities.
			const transitioned = new Set<Id<'playbookItems'>>();
			this.commands = this.commands.map((command) => {
				const current = this.confirmedChoices[command.itemId];
				if (
					transitioned.has(command.itemId) ||
					!current ||
					command.choice?.concessionId !== current.concessionId
				) {
					transitioned.add(command.itemId);
					return command;
				}
				return { ...command, choice: current };
			});
			this.intent = projectCommands(this.confirmedChoices, this.commands);
		}
		this.request = null;
		this.resolution = { kind: 'current' };
		this.clearError();
		this.record();
		this.start();
	}

	private start() {
		if (
			!this.canSave ||
			this.running ||
			this.error ||
			(this.policy && (!this.request || this.policyRefused))
		)
			return;
		if (!this.request) {
			if (!this.pending) return;
			if (Object.keys(this.choices).length > MAX_SELECTED_CONCESSIONS) {
				this.showSelectionLimit();
				return;
			}
			this.selectionLimitError = null;
			this.request = {
				id: this.id,
				choices: projectCommands(this.confirmedChoices, this.commands.slice(0, 25)),
				commands: this.commands.slice(0, 25),
				expectedEditRevision: this.confirmed.editRevision,
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

	private async send(request: RetainedSaveRequest, generation: number) {
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
				// Accept newer metadata without replacing a later subscription result.
				this.accept(result.state);
				if (result.status === 'conflict')
					this.resolution = { kind: 'conflict', ...(this.error ? { message: this.error } : {}) };
			}
			if (result.status === 'saved') {
				this.acknowledgeCommands();
				if (!this.conflict) this.resolution = { kind: 'current' };
			}
			this.request = null;
		} catch (cause) {
			if (!this.active || generation !== this.transportGeneration) return;
			if (this.confirmed.lastOperationId === request.operationId) {
				this.acknowledgeCommands();
				this.request = null;
			} else if (workBlockFromError(cause)) {
				this.acceptPolicy(workBlockFromError(cause));
				this.policyRefused = true;
			} else if (errorCode(cause) === 'SAVE_PROTOCOL_REQUIRED') {
				this.legacyRejected = true;
				this.resolution = {
					kind: 'conflict',
					message: saveError(cause, 'Recover your draft before continuing.')
				};
			} else
				this.fail(saveError(cause, 'We couldn’t save this contract. Your changes are still here.'));
		} finally {
			if (generation === this.transportGeneration) {
				this.running = null;
				this.record();
				if (this.active) this.start();
			}
		}
	}

	private acknowledgeCommands() {
		const ids = new Set(this.request?.commands?.map((c) => c.id) ?? []);
		if (ids.size) this.commands = this.commands.filter((c) => !ids.has(c.id));
		if (this.request && !this.request.commands) {
			// Preserve only choices made after the old immutable snapshot request.
			const delta = this.intentCommands(this.request.choices, this.intent);
			this.stageIntent(projectCommands(this.confirmedChoices, delta));
		} else if (this.legacyIntent) this.stageIntent(this.intent);
		else this.intent = projectCommands(this.confirmedChoices, this.commands);
		// A receipt resolves its own batch, not a conflict involving later local intent.
		if (!this.commands.length && !this.legacyIntent) this.resolution = { kind: 'current' };
	}
	retry() {
		if (!this.canSave || this.running) return;
		this.clearError();
		this.start();
	}

	async useConfirmedState() {
		// A request already handed to Convex cannot be cancelled. Wait for its outcome
		// before discarding intent so a late acknowledgement cannot start another save.
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
				(this.request &&
					(Boolean(this.request.commands) ||
						(!this.legacyRejected &&
							this.confirmed.editRevision <= this.request.expectedEditRevision)))
			)
				return false;
			// A newer edit revision prevents the old request from changing the server again.
			this.request = null;
			this.clearError();
			this.resolution = { kind: 'current' };
			this.selectionLimitError = null;
			this.commands = [];
			this.legacyIntent = false;
			this.useConfirmedChoices();
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
	/** An old client may have committed a request without delivering its response. */
	restartTransport() {
		if (this.deleted) return;
		this.transportGeneration++;
		this.running = null;
		this.clearError();
		if (this.pending && !this.recoveryPending) {
			this.recovery = {
				version: this.legacyIntent || (this.request && !this.request.commands) ? 5 : 6,
				commands: this.commands,
				base: this.confirmed,
				intent: this.intent,
				request: this.request,
				conflict: this.conflict
			};
		}
	}
	discard() {
		this.transportGeneration++;
		this.running = null;
		this.recovery = null;
		this.request = null;
		this.clearError();
		if (!this.deleted) this.resolution = { kind: 'current' };
		this.commands = [];
		this.legacyIntent = false;
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

	async savePending() {
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
