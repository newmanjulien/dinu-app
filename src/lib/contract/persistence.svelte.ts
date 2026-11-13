import type { ContractItemId } from './item-identity';
import type { Id } from '../../convex/_generated/dataModel';
import {
	commandsMatch,
	currentHead,
	projectCommands,
	selectedOptions,
	MAX_ACTIVITY_COMMANDS,
	MAX_SAVE_COMMANDS,
	type ActivityCommand
} from './activity-commands';
import type { PlaybookCommand } from './changes';
import type { ContractDraft } from './draft-recovery.svelte';
import {
	olderContractState,
	saveError,
	type ContractSaveResult,
	type ContractState,
	type LiveContractState
} from './saved';
import { MAX_SELECTED_CONCESSIONS } from '../document/selection-limits';
import { workBlockFromError, workBlockMessage, type ContractWorkBlock } from './work-policy';

export type ContractSaveRequest = {
	id: Id<'savedContracts'>;
	commands: ActivityCommand[];
	operationId: string;
};
type Resolution =
	| { kind: 'current' }
	| { kind: 'conflict'; message?: string }
	| { kind: 'failed'; message: string }
	| { kind: 'deleted' };

/** One durable ordered journal. Only the server allocates change and approval identities. */
export class ContractPersistence {
	confirmed: ContractState;
	private commands = $state.raw<ActivityCommand[]>([]);
	intent = $derived(projectCommands(this.commands));
	choices = $derived.by(() => selectedOptions(this.confirmed.playbook, this.intent));
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
			this.recoveryPending || this.conflict || Boolean(this.request) || this.commands.length > 0
		);
	}
	get editable() {
		return (
			this.canSave &&
			!this.policy &&
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
			(!this.conflict || Boolean(this.request)) &&
			!this.deleted &&
			!this.recoveryPending
		);
	}

	constructor(
		private id: Id<'savedContracts'>,
		initial: ContractState,
		private save: (
			request: ContractSaveRequest,
			signal: AbortSignal
		) => Promise<ContractSaveResult>,
		private checkpoint: (draft: ContractDraft | null) => void = () => {},
		recovery: ContractDraft | null = null
	) {
		this.confirmed = $state.raw(initial);
		this.policy = initial.workBlock ?? null;
		this.recovery = recovery;
		if (recovery) this.commands = structuredClone(recovery.commands);
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
		if (this.recoveryPending) return;
		this.checkpoint(
			this.deleted || !this.pending
				? null
				: {
						version: 10,
						commands: this.commands,
						base: this.confirmed,
						request: this.request,
						conflict: this.conflict
					}
		);
	}
	setOption(itemId: ContractItemId, optionId: string | null) {
		this.enqueue(itemId, { kind: 'set', optionId });
	}
	withdraw(itemId: ContractItemId) {
		this.enqueue(itemId, { kind: 'withdraw' });
	}
	private enqueue(itemId: ContractItemId, action: PlaybookCommand['action']) {
		if (!this.editable) return;
		const choices = selectedOptions(this.confirmed.playbook, { ...this.intent, [itemId]: action });
		if (Object.keys(choices).length > MAX_SELECTED_CONCESSIONS) {
			this.selectionLimitError = `You can select up to ${MAX_SELECTED_CONCESSIONS.toLocaleString('en-US')} Playbook options. Remove a selection before adding another.`;
			return;
		}
		this.selectionLimitError = null;
		this.commands = [
			...this.commands,
			{
				id: crypto.randomUUID(),
				itemId,
				expectedCurrentChangeId: currentHead(this.confirmed.playbook, itemId),
				action,
				occurredAt: Date.now()
			}
		];
		this.record();
		this.start();
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
			this.commands = [];
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
		this.confirmed = { ...next, workBlock: this.policy };
		if (own) {
			this.acknowledgeCommands(own, next);
			this.request = null;
			this.clearError();
		} else if (this.commands.length && !commandsMatch(next.playbook, this.commands))
			this.resolution = { kind: 'conflict', ...(this.error ? { message: this.error } : {}) };
		this.record();
		this.start();
	}
	private restore(next: ContractState) {
		const draft = this.recovery!;
		this.recovery = null;
		this.confirmed = { ...next, workBlock: this.policy };
		this.commands = structuredClone(draft.commands);
		this.request = draft.request ? structuredClone(draft.request) : null;
		this.resolution = draft.conflict ? { kind: 'conflict' } : { kind: 'current' };
		if (this.request && next.lastOperationId === this.request.operationId) {
			this.acknowledgeCommands(this.request, next);
			this.request = null;
		} else if (!commandsMatch(next.playbook, this.commands)) this.resolution = { kind: 'conflict' };
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
		// Explicit reapply gets new command identities. Original submitted bytes are never rewritten.
		this.commands = this.commands.map((command) => ({
			...command,
			id: crypto.randomUUID(),
			expectedCurrentChangeId: currentHead(this.confirmed.playbook, command.itemId),
			occurredAt: Date.now()
		}));
		this.resolution = { kind: 'current' };
		this.record();
		this.start();
	}
	private start() {
		if (
			!this.canSave ||
			this.running ||
			this.error ||
			this.policyRefused ||
			(this.policy && !this.request)
		)
			return;
		if (!this.request) {
			if (!this.commands.length) return;
			this.request = structuredClone({
				id: this.id,
				commands: this.commands.slice(0, MAX_SAVE_COMMANDS),
				operationId: crypto.randomUUID()
			});
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
			if (result.status === 'preparing')
				throw new Error('This contract change is still being prepared. Retry to check its result.');
			if (result.status === 'deleted') this.accept(null);
			else {
				// Receipts acknowledge exactly their commands, even after later subscription updates.
				if (!olderContractState(result.state, this.confirmed))
					this.confirmed = { ...result.state, workBlock: this.policy };
				if (result.status === 'saved') this.acknowledgeCommands(request, result.state);
				else this.resolution = { kind: 'conflict' };
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
				this.acknowledgeCommands(request, this.confirmed);
				this.request = null;
			} else if (workBlockFromError(cause)) {
				this.policyRefused = true;
				this.fail(workBlockMessage(workBlockFromError(cause)!));
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
	private acknowledgeCommands(request: ContractSaveRequest, committed: ContractState) {
		const ids = new Set(request.commands.map((command) => command.id));
		const touched = new Set(request.commands.map((command) => command.itemId));
		this.commands = this.commands
			.filter((command) => !ids.has(command.id))
			.map((command) =>
				touched.has(command.itemId)
					? { ...command, expectedCurrentChangeId: currentHead(committed.playbook, command.itemId) }
					: command
			);
		this.resolution = commandsMatch(this.confirmed.playbook, this.commands)
			? { kind: 'current' }
			: { kind: 'conflict' };
	}
	retry() {
		if (!this.canSave || this.running) return;
		this.policyRefused = false;
		this.clearError();
		this.start();
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
			this.commands = [];
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
		this.transportGeneration++;
		this.transport.abort();
		this.transport = new AbortController();
		this.running = null;
	}
	restartTransport() {
		if (this.deleted) return;
		this.replaceTransport();
		this.clearError();
		if (this.pending && !this.recoveryPending)
			this.recovery = {
				version: 10,
				commands: this.commands,
				base: this.confirmed,
				request: this.request,
				conflict: this.conflict
			};
	}
	discard() {
		this.replaceTransport();
		this.recovery = null;
		this.request = null;
		if (!this.deleted) this.resolution = { kind: 'current' };
		this.commands = [];
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
			!this.running &&
			!this.recoveryPending
		);
	}
	destroy() {
		this.active = false;
		this.replaceTransport();
	}
}
