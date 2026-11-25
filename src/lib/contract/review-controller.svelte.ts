import type { ConvexClient } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import {
	availableReviewDecisions,
	type ReviewDecision,
	type ReviewNavigation,
	type ReviewTag
} from './approval';
import type { ContractPersistence } from './persistence.svelte';
import { saveError } from './saved';

type DecisionArgs = FunctionArgs<typeof api.approvals.decide>;
type RequestArgs = FunctionArgs<typeof api.approvals.request>;
type CompletionArgs = FunctionArgs<typeof api.approvals.complete>;

type Options = {
	client: Pick<ConvexClient, 'mutation'>;
	membershipId: Id<'memberships'>;
	contractId: Id<'savedContracts'>;
	persistence: ContractPersistence;
	isAdmin: () => boolean;
	canReview: () => boolean;
	canRequest: () => boolean;
	preflight?: () => Promise<void>;
	tags: () => readonly ReviewTag[];
};

/** Synchronous Playbook approval decisions, requests, and review completion. */
export class ContractReviewController {
	deciding = $state(false);
	requesting = $state(false);
	completionBusy = $state(false);
	navigation = $state.raw<ReviewNavigation>();
	private _requestError = $state.raw<{
		generation: number;
		title: string;
		choices: Readonly<Record<string, string>>;
		message: string;
	} | null>(null);
	private _completionError = $state.raw<{ key: string; message: string } | null>(null);
	private _decisionError = $state.raw<{
		itemId: string;
		optionId: string;
		status: ReviewTag['status'];
		message: string;
	} | null>(null);
	private decisions = new Map<string, DecisionArgs>();
	private requestAttempt: RequestArgs | null = null;
	private completionAttempt: CompletionArgs | null = null;
	private active = true;
	private available = true;

	constructor(private options: Options) {}

	get completion() {
		const completion = this.options.persistence.confirmed.review.completion;
		return this.options.isAdmin() && completion?.kind === 'awaitingConfirmation'
			? completion
			: null;
	}
	get completionKey() {
		const completion = this.completion;
		return completion ? `${completion.generation}:${completion.decidedAt}` : null;
	}
	get requestError() {
		const error = this._requestError;
		if (!error) return null;
		const confirmed = this.options.persistence.confirmed;
		return error.generation === confirmed.review.generation &&
			error.title === confirmed.title &&
			error.choices === this.options.persistence.choices
			? error.message
			: null;
	}
	get completionError() {
		return this._completionError && this._completionError.key === this.completionKey
			? this._completionError.message
			: null;
	}
	get decisionError() {
		const error = this._decisionError;
		if (!error) return null;
		const current = this.options.tags().find((tag) => tag.itemId === error.itemId);
		return current && current.optionId === error.optionId && current.status === error.status
			? { itemId: error.itemId, message: error.message }
			: null;
	}
	setLifetime(available: boolean) {
		this.available = available;
	}
	reconcile() {
		const tagsById = new Map(this.options.tags().map((tag) => [tag.itemId, tag]));
		const confirmed = this.options.persistence.confirmed;
		const confirmedRevision = confirmed.stateRevision;
		const confirmedGeneration = confirmed.review.generation;
		if (!this.deciding) {
			for (const [key, attempt] of this.decisions) {
				const current = tagsById.get(attempt.itemId);
				if (
					!current ||
					current.optionId !== attempt.expectedOptionId ||
					attempt.expectedStateRevision !== confirmedRevision
				) {
					this.decisions.delete(key);
				}
			}
		}
		if (this._decisionError) {
			const current = tagsById.get(this._decisionError.itemId as Id<'playbookItems'>);
			if (
				!current ||
				current.optionId !== this._decisionError.optionId ||
				current.status !== this._decisionError.status
			)
				this._decisionError = null;
		}
		if (
			this._requestError &&
			(this._requestError.generation !== confirmedGeneration ||
				this._requestError.title !== confirmed.title ||
				this._requestError.choices !== this.options.persistence.choices)
		) {
			this._requestError = null;
		}
		if (
			this.requestAttempt &&
			this.requestAttempt.expectedGeneration !== confirmedGeneration &&
			!this.requesting
		) {
			this.requestAttempt = null;
		}
		if (this._completionError && this._completionError.key !== this.completionKey) {
			this._completionError = null;
		}
		if (
			this.completionAttempt &&
			this.completionKey !==
				`${this.completionAttempt.expectedGeneration}:${this.completionAttempt.expectedDecidedAt}` &&
			!this.completionBusy
		) {
			this._completionError = null;
			this.completionAttempt = null;
		}
	}

	async decide(tag: ReviewTag, action: ReviewDecision) {
		const current = this.options.tags().find((value) => value.itemId === tag.itemId);
		if (
			!this.active ||
			!this.available ||
			this.deciding ||
			!this.options.canReview() ||
			!current ||
			current.disabled ||
			!availableReviewDecisions(current.status).includes(action)
		)
			return;
		const key = `${tag.itemId}:${action}`;
		this.deciding = true;
		this._decisionError = null;
		let attemptedStatus = current.status;
		try {
			await this.options.preflight?.();
			if (!(await this.options.persistence.savePending())) return;
			if (!this.active || !this.available || !this.options.canReview()) return;
			let args = this.decisions.get(key);
			if (
				args &&
				(args.expectedOptionId !== tag.optionId ||
					args.expectedStateRevision !== this.options.persistence.confirmed.stateRevision)
			) {
				this.decisions.delete(key);
				args = undefined;
			}
			if (!args) {
				const latest = this.options.tags().find((value) => value.itemId === tag.itemId);
				if (
					!latest ||
					latest.optionId !== tag.optionId ||
					!availableReviewDecisions(latest.status).includes(action)
				)
					return;
				attemptedStatus = latest.status;
				args = {
					membershipId: this.options.membershipId,
					id: this.options.contractId,
					itemId: tag.itemId,
					expectedOptionId: tag.optionId,
					expectedStateRevision: this.options.persistence.confirmed.stateRevision,
					action,
					operationId: crypto.randomUUID()
				};
				this.decisions.set(key, args);
			}
			await this.options.client.mutation(api.approvals.decide, args);
			this.decisions.delete(key);
			if (this.active) this.navigation = { afterItemId: tag.itemId };
		} catch (error) {
			if (error instanceof ConvexError) this.decisions.delete(key);
			if (this.active && this.available)
				this._decisionError = {
					itemId: tag.itemId,
					optionId: tag.optionId,
					status: attemptedStatus,
					message: saveError(error, 'We couldn’t save this decision. Choose it again to retry.')
				};
		} finally {
			if (this.active) this.deciding = false;
		}
	}

	async requestApproval() {
		if (!this.active || !this.available || this.requesting || !this.options.canRequest()) return;
		this.requesting = true;
		this._requestError = null;
		let attemptedGeneration = this.options.persistence.confirmed.review.generation;
		try {
			await this.options.preflight?.();
			if (!(await this.options.persistence.savePending())) return;
			if (!this.active || !this.available || !this.options.canRequest()) return;
			if (
				this.requestAttempt &&
				this.requestAttempt.expectedGeneration !==
					this.options.persistence.confirmed.review.generation
			) {
				this.requestAttempt = null;
			}
			this.requestAttempt ??= {
				membershipId: this.options.membershipId,
				id: this.options.contractId,
				expectedGeneration: this.options.persistence.confirmed.review.generation,
				operationId: crypto.randomUUID()
			};
			attemptedGeneration = this.requestAttempt.expectedGeneration;
			await this.options.client.mutation(api.approvals.request, this.requestAttempt);
			this.requestAttempt = null;
		} catch (error) {
			if (error instanceof ConvexError) this.requestAttempt = null;
			if (this.active && this.available)
				this._requestError = {
					generation: attemptedGeneration,
					title: this.options.persistence.confirmed.title,
					choices: this.options.persistence.choices,
					message: saveError(error, 'We couldn’t request approval. Try again.')
				};
		} finally {
			if (this.active) this.requesting = false;
		}
	}

	async resolveCompletion() {
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
		this._completionError = null;
		let attemptedKey = this.completionKey;
		try {
			await this.options.preflight?.();
			if (!(await this.options.persistence.savePending())) return;
			if (!this.active || !this.available || !this.options.canReview() || !this.completion) return;
			if (
				this.completionAttempt &&
				(this.completionAttempt.expectedGeneration !== this.completion.generation ||
					this.completionAttempt.expectedDecidedAt !== this.completion.decidedAt)
			) {
				this.completionAttempt = null;
			}
			const attempt = (this.completionAttempt ??= {
				membershipId: this.options.membershipId,
				id: this.options.contractId,
				expectedGeneration: this.completion.generation,
				expectedDecidedAt: this.completion.decidedAt,
				operationId: crypto.randomUUID()
			});
			attemptedKey = `${attempt.expectedGeneration}:${attempt.expectedDecidedAt}`;
			await this.options.client.mutation(api.approvals.complete, attempt);
			this.completionAttempt = null;
		} catch (error) {
			if (error instanceof ConvexError) this.completionAttempt = null;
			if (this.active && this.available && attemptedKey)
				this._completionError = {
					key: attemptedKey,
					message: saveError(error, 'We couldn’t save your choice. Try again.')
				};
		} finally {
			if (this.active) this.completionBusy = false;
		}
	}

	destroy() {
		this.active = false;
	}
}
