import { ConvexError } from 'convex/values';
import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import {
	reviewStatus,
	type ReviewDecision,
	type ReviewNavigation,
	type ReviewTag
} from './approval';
import type { ContractPersistence } from './persistence.svelte';
import { saveError } from './saved';

type DecisionAttempt = {
	operationId: string;
	concessionId: string;
	applicationId: string;
	status: ReviewDecision;
};
type Options = {
	client: Pick<ConvexClient, 'mutation'>;
	membershipId: Id<'memberships'>;
	contractId: Id<'savedContracts'>;
	persistence: ContractPersistence;
	isAdmin: () => boolean;
	canReview: () => boolean;
	/** Eligibility excludes this controller's own requesting flag. */
	canRequest: () => boolean;
	preflight?: () => Promise<void>;
	tags: () => readonly ReviewTag[];
};

/** Owns review operations and reconciliation. View focus/navigation consumes navigation. */
export class ContractReviewController {
	deciding = $state(false);
	requesting = $state(false);
	requestError = $state<string | null>(null);
	completionBusy = $state(false);
	completionError = $state<string | null>(null);
	navigation = $state.raw<ReviewNavigation>();
	decisionError = $state.raw<{
		itemId: string;
		attempt: DecisionAttempt;
		changesStatus: boolean;
		message: string;
	} | null>(null);
	private attempts = new Map<string, DecisionAttempt>();
	private active = true;
	private requestAttempt: { operationId: string; expectedEditRevision: number } | null = null;
	private generation: number | null = null;

	constructor(private readonly options: Options) {}

	get completion() {
		const completion = this.options.persistence.confirmed.reviewCompletion;
		return this.options.isAdmin() && completion?.kind === 'awaitingConfirmation'
			? completion
			: null;
	}
	get completionGeneration() {
		return this.completion ? this.options.persistence.confirmed.reviewGeneration : null;
	}
	private settled(itemId: string, attempt: DecisionAttempt, changesStatus = true) {
		const state = this.options.persistence.confirmed;
		const application = state.applications[itemId as Id<'playbookItems'>];
		return (
			application?.concessionId !== attempt.concessionId ||
			application.approval?.applicationId !== attempt.applicationId ||
			(changesStatus &&
				reviewStatus(state, itemId, attempt.concessionId, attempt.applicationId) === attempt.status)
		);
	}
	/** Subscriptions can acknowledge a write whose transport response was lost. */
	reconcile() {
		if (!this.active) return;
		if (this.generation !== this.completionGeneration) {
			this.generation = this.completionGeneration;
			this.completionError = null;
		}
		for (const [itemId, attempt] of this.attempts)
			if (this.settled(itemId, attempt, false)) this.attempts.delete(itemId);
		if (
			this.decisionError &&
			this.settled(
				this.decisionError.itemId,
				this.decisionError.attempt,
				this.decisionError.changesStatus
			)
		)
			this.decisionError = null;
	}
	async decide(tag: ReviewTag, status: ReviewDecision) {
		const current = this.options
			.tags()
			.find(
				(value) =>
					value.itemId === tag.itemId &&
					value.applicationId === tag.applicationId &&
					value.concessionId === tag.concessionId
			);
		if (!this.active || !this.options.canReview() || !current || current.disabled) return;
		const prior = this.attempts.get(tag.itemId);
		const attempt =
			prior?.concessionId === tag.concessionId &&
			prior.applicationId === tag.applicationId &&
			prior.status === status
				? prior
				: {
						operationId: crypto.randomUUID(),
						concessionId: tag.concessionId,
						applicationId: tag.applicationId,
						status
					};
		const changesStatus = current.status !== status;
		this.attempts.set(tag.itemId, attempt);
		this.deciding = true;
		this.decisionError = null;
		try {
			await this.options.preflight?.();
			if (!this.active || !this.options.canReview()) return;
			await this.options.client.mutation(api.contractApprovals.decide, {
				membershipId: this.options.membershipId,
				id: this.options.contractId,
				itemId: tag.itemId as Id<'playbookItems'>,
				concessionId: tag.concessionId,
				applicationId: tag.applicationId,
				status,
				operationId: attempt.operationId,
				protocol: 1
			});
			if (!this.active) return;
			this.attempts.delete(tag.itemId);
			if (this.options.persistence.confirmed.reviewCompletion?.kind !== 'awaitingConfirmation')
				this.navigation = { afterItemId: tag.itemId };
		} catch (error) {
			if (this.active && !this.settled(tag.itemId, attempt, changesStatus))
				this.decisionError = {
					itemId: tag.itemId,
					attempt,
					changesStatus,
					message: saveError(error, 'We couldn’t save this decision. Choose it again to retry.')
				};
		} finally {
			if (this.active) this.deciding = false;
		}
	}
	async requestApproval() {
		if (!this.active || this.requesting || !this.options.canRequest()) return;
		this.requesting = true;
		this.requestError = null;
		try {
			await this.options.preflight?.();
			if (!this.active || this.options.persistence.workBlock || !this.options.canRequest()) return;
			this.requestAttempt ??= {
				operationId: crypto.randomUUID(),
				expectedEditRevision: this.options.persistence.confirmed.editRevision
			};
			await this.options.client.mutation(api.contractApprovals.request, {
				membershipId: this.options.membershipId,
				id: this.options.contractId,
				...this.requestAttempt
			});
			this.requestAttempt = null;
		} catch (error) {
			if (error instanceof ConvexError) this.requestAttempt = null;
			if (this.active)
				this.requestError = saveError(error, 'We couldn’t request approval. Try again.');
		} finally {
			if (this.active) this.requesting = false;
		}
	}
	async resolveCompletion(reset: boolean) {
		if (
			!this.active ||
			this.completionBusy ||
			this.deciding ||
			!this.options.canReview() ||
			!this.completion
		)
			return;
		const generation = this.options.persistence.confirmed.reviewGeneration;
		this.completionBusy = true;
		this.completionError = null;
		try {
			await this.options.preflight?.();
			if (!this.active || !this.options.canReview()) return;
			const result = await this.options.client.mutation(
				reset ? api.contractApprovals.resetCompletion : api.contractApprovals.confirmCompletion,
				{
					membershipId: this.options.membershipId,
					id: this.options.contractId,
					expectedGeneration: generation
				}
			);
			if (this.active && result.outcome === 'reset') {
				this.attempts.clear();
				this.decisionError = null;
				this.navigation = {};
			}
		} catch (error) {
			if (this.active && this.completionGeneration === generation)
				this.completionError = saveError(error, 'We couldn’t save your choice. Try again.');
		} finally {
			if (this.active) this.completionBusy = false;
		}
	}
	destroy() {
		this.active = false;
		this.attempts.clear();
	}
}
