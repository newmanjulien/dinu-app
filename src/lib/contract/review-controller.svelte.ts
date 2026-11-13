import { reviewOperationInputs } from './changes';
import type { ConvexClient } from 'convex/browser';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { ReviewDecision, ReviewNavigation, ReviewTag } from './approval';
import type { ContractPersistence } from './persistence.svelte';
import { awaitContractOperation } from './operation-result';
import { saveError } from './saved';

type DecisionArgs = FunctionArgs<typeof api.contractApprovals.decideChange>;
type RequestArgs = FunctionArgs<typeof api.contractApprovals.request>;
type CompletionArgs = FunctionArgs<typeof api.contractApprovals.confirmCompletion>;
type Options = {
	client: Pick<ConvexClient, 'mutation' | 'onUpdate'>;
	membershipId: Id<'memberships'>;
	contractId: Id<'savedContracts'>;
	persistence: ContractPersistence;
	isAdmin: () => boolean;
	canReview: () => boolean;
	canRequest: () => boolean;
	identity: () => string | undefined;
	preflight?: () => Promise<void>;
	tags: () => readonly ReviewTag[];
};
/** One native operation retains its exact original arguments until a factual result/refusal. */
export class ContractReviewController {
	deciding = $state(false);
	requesting = $state(false);
	requestError = $state<string | null>(null);
	completionBusy = $state(false);
	completionError = $state<string | null>(null);
	navigation = $state.raw<ReviewNavigation>();
	decisionError = $state.raw<{ changeId: string; message: string } | null>(null);
	private decisions = new Map<string, DecisionArgs>();
	private requestAttempt: RequestArgs | null = null;
	private completionAttempt: CompletionArgs | null = null;
	private active = true;
	private lifetime: unknown;
	private available = true;
	private waiters = new Set<AbortController>();
	constructor(private options: Options) {}
	get completion() {
		const current = this.options.persistence.confirmed.playbookCompletion;
		return this.options.isAdmin() && current?.completion.kind === 'awaitingConfirmation'
			? current
			: null;
	}
	get completionGeneration() {
		return this.completion?.reviewIdentity ?? null;
	}
	setLifetime(available: boolean, generation: unknown) {
		if ((!available && this.available) || generation !== this.lifetime)
			for (const waiter of this.waiters) waiter.abort();
		this.available = available;
		this.lifetime = generation;
	}
	reconcile() {
		if (this.decisionError) {
			const current = this.options
				.tags()
				.find((tag) => tag.changeId === this.decisionError!.changeId);
			const attempt = [...this.decisions.values()].find(
				(args) => args.changeId === this.decisionError!.changeId
			);
			if (!current || (attempt && current.decisionId !== attempt.expectedDecisionId))
				this.decisionError = null;
		}
		if (
			this.completionAttempt &&
			this.completionGeneration !== this.completionAttempt.expectedIdentity &&
			!this.completionBusy
		) {
			this.completionAttempt = null;
			this.completionError = null;
		}
	}
	private async settle<T extends { status: string }>(
		kind: 'change-decision' | 'approval-request' | 'review-completion',
		args: DecisionArgs | RequestArgs | CompletionArgs,
		result: T
	): Promise<T> {
		if (result.status !== 'preparing') return result;
		const waiter = new AbortController();
		this.waiters.add(waiter);
		if (!this.active || !this.available) waiter.abort();
		try {
			return await awaitContractOperation<T>(
				this.options.client,
				{
					membershipId: this.options.membershipId,
					id: this.options.contractId,
					kind,
					operationId: args.operationId,
					inputs: reviewOperationInputs({ kind, args })
				},
				waiter.signal
			);
		} finally {
			this.waiters.delete(waiter);
		}
	}
	async decide(tag: ReviewTag, action: ReviewDecision) {
		const current = this.options.tags().find((value) => value.changeId === tag.changeId);
		const eligibility =
			action === 'approve'
				? current?.approve
				: action === 'decline'
					? current?.decline
					: current?.undo;
		if (
			!this.active ||
			!this.available ||
			this.deciding ||
			!this.options.canReview() ||
			!current ||
			current.disabled ||
			eligibility?.allowed !== true
		)
			return;
		const key = `${tag.changeId}:${action}`;
		this.deciding = true;
		this.decisionError = null;
		try {
			await this.options.preflight?.();
			await this.options.persistence.savePending();
			if (!this.active || !this.available || !this.options.canReview()) return;
			let args = this.decisions.get(key);
			if (!args) {
				const latest = this.options.tags().find((value) => value.changeId === tag.changeId);
				if (
					!latest ||
					latest.decisionId !== tag.decisionId ||
					latest.currentChangeId !== tag.currentChangeId
				)
					return;
				const state = this.options.persistence.confirmed;
				args = {
					membershipId: this.options.membershipId,
					id: this.options.contractId,
					changeId: tag.changeId,
					expectedDecisionId: tag.decisionId,
					action,
					expectedDocument: {
						documentId: state.documentId,
						documentRevision: state.documentRevision
					},
					operationId: crypto.randomUUID()
				};
				this.decisions.set(key, args);
			}
			await this.settle(
				'change-decision',
				args,
				await this.options.client.mutation(api.contractApprovals.decideChange, args)
			);
			this.decisions.delete(key);
			if (this.active) this.navigation = { afterChangeId: tag.changeId };
		} catch (error) {
			if (error instanceof ConvexError) this.decisions.delete(key);
			if (this.active && this.available)
				this.decisionError = {
					changeId: tag.changeId,
					message: saveError(error, 'We couldn’t save this decision. Choose it again to retry.')
				};
		} finally {
			if (this.active) this.deciding = false;
		}
	}
	async requestApproval() {
		if (!this.active || !this.available || this.requesting || !this.options.canRequest()) return;
		this.requesting = true;
		this.requestError = null;
		try {
			await this.options.preflight?.();
			await this.options.persistence.savePending();
			if (!this.active || !this.available || !this.options.canRequest()) return;
			if (!this.requestAttempt) {
				const state = this.options.persistence.confirmed,
					identity = this.options.identity();
				if (!identity) return;
				this.requestAttempt = {
					membershipId: this.options.membershipId,
					id: this.options.contractId,
					context: 'playbook',
					expectedIdentity: identity,
					expectedDocument: {
						documentId: state.documentId,
						documentRevision: state.documentRevision
					},
					operationId: crypto.randomUUID()
				};
			}
			await this.settle(
				'approval-request',
				this.requestAttempt,
				await this.options.client.mutation(api.contractApprovals.request, this.requestAttempt)
			);
			this.requestAttempt = null;
		} catch (error) {
			if (error instanceof ConvexError) this.requestAttempt = null;
			if (this.active && this.available)
				this.requestError = saveError(error, 'We couldn’t request approval. Try again.');
		} finally {
			if (this.active) this.requesting = false;
		}
	}
	async resolveCompletion(notify = true) {
		if (
			!this.active ||
			!this.available ||
			this.completionBusy ||
			this.deciding ||
			!this.options.canReview() ||
			!this.completion
		)
			return;
		this.completionBusy = true;
		this.completionError = null;
		try {
			await this.options.preflight?.();
			if (!this.active || !this.available || !this.options.canReview()) return;
			this.completionAttempt ??= {
				membershipId: this.options.membershipId,
				id: this.options.contractId,
				context: 'playbook',
				expectedIdentity: this.completion!.reviewIdentity,
				operationId: crypto.randomUUID(),
				notify
			};
			const args = this.completionAttempt;
			const result: FunctionReturnType<typeof api.contractApprovals.confirmCompletion> =
				await this.settle(
					'review-completion',
					args,
					await this.options.client.mutation(api.contractApprovals.confirmCompletion, args)
				);
			this.completionAttempt = null;
			if (result.outcome === 'stale')
				throw new ConvexError(
					'The review changed. Review the current changes before sending results.'
				);
		} catch (error) {
			if (error instanceof ConvexError) this.completionAttempt = null;
			if (this.active && this.available)
				this.completionError = saveError(error, 'We couldn’t save your choice. Try again.');
		} finally {
			if (this.active) this.completionBusy = false;
		}
	}
	destroy() {
		this.active = false;
		for (const waiter of this.waiters) waiter.abort();
		this.waiters.clear();
	}
}
