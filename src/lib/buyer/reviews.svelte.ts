import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import { nativeSellerCommand, type BuyerSeller } from './seller.svelte';
import type { DiscussionThread } from '$lib/discussions/session.svelte';
import type { ReviewTag, ReviewDecision, ReviewNavigation } from '$lib/contract/approval';
import { ContractReviewPages } from '$lib/contract/review-pages.svelte';
import { saveError } from '$lib/contract/saved';
import { ReadAttempt } from '$lib/auth/attempt';

type Overview = FunctionReturnType<typeof api.contractApprovals.overview>;
type Content = Pick<
	FunctionReturnType<typeof api.buyerLinks.currentDocument>,
	'contentIdentity' | 'contentRevision' | 'displayIdentity'
>;
type Support = FunctionReturnType<typeof api.discussionProposals.supportState>;
export class BuyerChangeReview {
	state = $state.raw<Overview>();
	pages = $state.raw<ContractReviewPages>();
	busy = $state(false);
	footerError = $state<string | null>(null);
	passageError = $state<{ threadId: string; message: string } | null>(null);
	decisionError = $state<{ changeId: string; message: string } | null>(null);
	navigation = $state.raw<ReviewNavigation>();
	dismissed = $state<string | null>();
	private epoch = 0;
	private content?: () => Content;
	private enabled = () => false;
	private proposal = $state.raw<{ identity: string; state: Support }>();
	constructor(readonly seller: BuyerSeller) {}
	connect(content: () => Content, enabled: () => boolean) {
		this.epoch++;
		this.busy = false;
		this.state = undefined;
		this.footerError = null;
		this.passageError = null;
		this.decisionError = null;
		this.content = content;
		this.enabled = enabled;
		const seller = this.seller,
			client = seller.client,
			viewer = seller.viewer,
			identity = seller.identity,
			account = seller.accountIdentity;
		if (!client || !viewer || !seller.visible) return;
		let active = true;
		const current = () =>
			active &&
			seller.visible &&
			identity === seller.identity &&
			account === seller.accountIdentity &&
			client === seller.client &&
			viewer.role === seller.viewer?.role;
		const pages = (this.pages = new ContractReviewPages({
			client,
			membershipId: viewer.membershipId,
			id: viewer.contractId,
			kind: 'buyer-proposal',
			documentId: () => content().contentIdentity,
			enabled: () => current() && enabled(),
			generation: () =>
				JSON.stringify([identity, account, seller.viewer?.role, content().displayIdentity])
		}));
		const stop = client.onUpdate(
			api.contractApprovals.overview,
			{ membershipId: viewer.membershipId, id: viewer.contractId, context: 'buyer-link' },
			(state) => {
				if (current()) this.state = state;
			},
			(error) => {
				if (current()) {
					this.state = undefined;
					this.footerError = saveError(
						error,
						'Buyer reviews are unavailable. Reconnect your account to try again.'
					);
				}
			}
		);
		return () => {
			active = false;
			this.epoch++;
			this.busy = false;
			stop();
			pages.destroy();
			if (this.pages === pages) this.pages = undefined;
			this.state = undefined;
			this.proposal = undefined;
			this.navigation = undefined;
		};
	}
	get changes() {
		return this.pages?.rows ?? [];
	}
	get coherent() {
		const content = this.content?.(),
			expected = this.seller.viewer?.expectation;
		return Boolean(
			this.enabled() &&
			this.seller.visible &&
			content &&
			expected &&
			content.contentIdentity === expected.documentId &&
			content.contentRevision === expected.documentRevision
		);
	}
	get submitted() {
		const request = this.state?.request;
		return Boolean(
			request &&
			(request.status === 'sending' ||
				request.status === 'sent' ||
				(request.status === 'uncertain' && !request.retryEligible)) &&
			this.state!.summary.pendingCount > 0 &&
			this.state!.unsubmittedPendingCount === 0
		);
	}
	get completion() {
		const completion = this.seller.viewer?.completion;
		return Boolean(
			this.state?.summary.complete &&
			completion?.reviewIdentity === this.state.summary.identity &&
			completion.completion.kind === 'awaitingConfirmation' &&
			this.dismissed !== completion.reviewIdentity
		);
	}
	tagsFor(displayed: Content): ReviewTag[] | undefined {
		if (!this.coherent || this.content?.().displayIdentity !== displayed.displayIdentity) return;
		return this.changes.map((change) => ({
			...change,
			admin: this.seller.viewer?.role === 'admin',
			disabled: this.busy,
			...(this.decisionError?.changeId === change.changeId
				? { error: this.decisionError.message }
				: {})
		}));
	}
	private proposalIdentity(thread: DiscussionThread) {
		return JSON.stringify([
			this.seller.identity,
			this.seller.accountIdentity,
			this.seller.viewer?.role,
			this.content?.().displayIdentity,
			thread.id,
			thread.root.id,
			thread.root.revision
		]);
	}
	supportFor(thread: DiscussionThread) {
		return this.proposal?.identity === this.proposalIdentity(thread)
			? this.proposal.state
			: undefined;
	}
	watchProposal(thread: DiscussionThread) {
		const viewer = this.seller.viewer,
			client = this.seller.client,
			content = this.content?.();
		if (!viewer || !client || !content || !this.coherent || thread.root.deleted) return;
		const identity = this.proposalIdentity(thread);
		let active = true;
		let readError: BuyerChangeReview['passageError'] = null;
		const attempt = new ReadAttempt(15_000);
		attempt.signal.addEventListener(
			'abort',
			() => {
				if (active && identity === this.proposalIdentity(thread)) {
					this.passageError = {
						threadId: thread.id,
						message: 'Couldn’t check this proposal in time. Try again.'
					};
					readError = this.passageError;
				}
			},
			{ once: true }
		);
		this.passageError = null;
		const stop = client.onUpdate(
			api.discussionProposals.supportState,
			{
				membershipId: viewer.membershipId,
				id: viewer.contractId,
				token: this.seller.token,
				expectedDocument: {
					documentId: content.contentIdentity,
					documentRevision: content.contentRevision
				},
				threadId: thread.id,
				rootMessageId: thread.root.id,
				expectedRootRevision: thread.root.revision
			},
			(state) => {
				attempt.complete();
				if (active && this.coherent && identity === this.proposalIdentity(thread)) {
					this.proposal = { identity, state };
					if (this.passageError === readError) this.passageError = null;
					readError = null;
				}
			},
			(error) => {
				attempt.complete();
				if (active && identity === this.proposalIdentity(thread)) {
					this.proposal = undefined;
					this.passageError = {
						threadId: thread.id,
						message: saveError(error, 'Couldn’t check this proposal. Try again.')
					};
					readError = this.passageError;
				}
			}
		);
		return () => {
			active = false;
			attempt.abort();
			stop();
		};
	}
	async accept(thread: DiscussionThread) {
		const support = this.supportFor(thread),
			content = this.content?.();
		if (this.busy || !this.coherent || !support || !content) return;
		const withdraw = Boolean(
			support.currentRootMessageId === thread.root.id &&
			support.currentRootRevision === thread.root.revision &&
			support.currentChangeId &&
			support.currentChangeId !== support.appliedChangeId
		);
		this.busy = true;
		this.passageError = null;
		const epoch = this.epoch;
		try {
			await this.seller.perform(
				`support:${thread.id}`,
				(viewer, operationId) => {
					const args = {
						membershipId: viewer.membershipId,
						id: viewer.contractId,
						token: this.seller.token,
						expectedDocument: {
							documentId: content.contentIdentity,
							documentRevision: content.contentRevision
						},
						threadId: thread.id,
						rootMessageId: thread.root.id,
						expectedRootRevision: thread.root.revision,
						expectedCurrentChangeId: support.currentChangeId,
						expectedDecisionId: support.decisionId,
						operationId
					};
					if (withdraw) {
						const command = { ...args, changeId: support.currentChangeId! };
						return nativeSellerCommand('proposal-support', command, (client) =>
							client.mutation(api.discussionProposals.withdraw, command)
						);
					}
					return nativeSellerCommand('proposal-support', args, (client) =>
						client.mutation(api.discussionProposals.support, args)
					);
				},
				!withdraw
			);
		} catch (error) {
			if (epoch === this.epoch)
				this.passageError = {
					threadId: thread.id,
					message: saveError(error, 'The proposal could not be saved. Try again.')
				};
		} finally {
			if (epoch === this.epoch) this.busy = false;
		}
	}
	async decide(tag: ReviewTag, action: ReviewDecision) {
		const content = this.content?.(),
			current = this.changes.find((change) => change.changeId === tag.changeId);
		if (
			this.busy ||
			!this.coherent ||
			!content ||
			!current ||
			current[action].allowed !== true ||
			this.seller.viewer?.role !== 'admin'
		)
			return;
		this.busy = true;
		this.decisionError = null;
		const epoch = this.epoch;
		try {
			await this.seller.perform(`decide:${tag.changeId}:${action}`, (viewer, operationId) => {
				const args = {
					membershipId: viewer.membershipId,
					id: viewer.contractId,
					expectedDocument: {
						documentId: content.contentIdentity,
						documentRevision: content.contentRevision
					},
					changeId: tag.changeId,
					expectedDecisionId: tag.decisionId,
					action,
					operationId
				};
				return nativeSellerCommand('change-decision', args, (client) =>
					client.mutation(api.contractApprovals.decideChange, args)
				);
			});
			if (epoch === this.epoch) this.navigation = { afterChangeId: tag.changeId };
		} catch (error) {
			if (epoch === this.epoch)
				this.decisionError = {
					changeId: tag.changeId,
					message: saveError(error, 'The review could not be saved. Try again.')
				};
		} finally {
			if (epoch === this.epoch) this.busy = false;
		}
	}
	async submit() {
		const state = this.state,
			content = this.content?.();
		if (
			this.busy ||
			!this.coherent ||
			!state ||
			!content ||
			!state.summary.pendingCount ||
			this.submitted
		)
			return;
		this.busy = true;
		this.footerError = null;
		const epoch = this.epoch;
		try {
			await this.seller.perform('submit:buyer-link', (viewer, operationId) => {
				const args = {
					membershipId: viewer.membershipId,
					id: viewer.contractId,
					context: 'buyer-link' as const,
					token: this.seller.token,
					expectedDocument: {
						documentId: content.contentIdentity,
						documentRevision: content.contentRevision
					},
					expectedIdentity: state.summary.identity,
					operationId
				};
				return nativeSellerCommand('approval-request', args, (client) =>
					client.mutation(api.contractApprovals.request, args)
				);
			});
		} catch (error) {
			if (epoch === this.epoch)
				this.footerError = saveError(error, 'The approval request could not be sent. Try again.');
		} finally {
			if (epoch === this.epoch) this.busy = false;
		}
	}
	async complete(notify = true) {
		const completion = this.seller.viewer?.completion;
		if (this.busy || !this.coherent || !this.completion || !completion) return;
		this.busy = true;
		this.footerError = null;
		const epoch = this.epoch;
		try {
			const result = await this.seller.perform<
				FunctionReturnType<typeof api.contractApprovals.confirmCompletion>
			>('results:buyer-link', (viewer, operationId) => {
				const args = {
					membershipId: viewer.membershipId,
					id: viewer.contractId,
					context: 'buyer-link' as const,
					token: this.seller.token,
					expectedIdentity: completion.reviewIdentity,
					operationId,
					notify
				};
				return nativeSellerCommand('review-completion', args, (client) =>
					client.mutation(api.contractApprovals.confirmCompletion, args)
				);
			});
			if (result.outcome === 'stale')
				throw new Error('The review changed. Review the current changes before completing it.');
			if (epoch === this.epoch) this.dismissed = completion.reviewIdentity;
		} catch (error) {
			if (epoch === this.epoch)
				this.footerError = saveError(error, 'The review could not be completed. Try again.');
		} finally {
			if (epoch === this.epoch) this.busy = false;
		}
	}
}
