import { ConvexError } from 'convex/values';
import type { ConvexClient } from 'convex/browser';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import type { ContractEditors } from '$lib/contract/editors.svelte';
import { saveError } from '$lib/contract/saved';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import { flushBuyerLinkCopy, journalBuyerLinkCopy } from './copy-progress';
import { buyerPath } from './urls';

type Link = FunctionReturnType<typeof api.buyerLinkActions.ensureLatest>;
type Capture = {
	args: FunctionArgs<typeof api.buyerLinkActions.ensureLatest>;
	link?: Link;
	work?: Promise<Link>;
};

/** Link copying with shared creation and retry state. */
export class BuyerLinkController {
	busy = $state<string | null>(null);
	error = $state<string | null>(null);
	manualUrl = $state<string | null>(null);
	private operation: Capture | undefined;
	private alive = true;
	constructor(
		private client: Pick<ConvexClient, 'query' | 'action' | 'mutation' | 'connectionState'>,
		private editors: Pick<ContractEditors, 'reserveForLink'>,
		private membershipId: Id<'memberships'>,
		private id: Id<'savedContracts'>,
		private onCopied: () => void
	) {}
	destroy() {
		this.alive = false;
		this.manualUrl = null;
	}
	async copy() {
		if (this.busy || !this.alive) return;
		this.error = null;
		this.manualUrl = null;
		this.busy = 'Checking link…';
		const deadline = new ReadAttempt(20_000);
		try {
			if (!this.client.connectionState().isWebSocketConnected)
				throw new ConvexError('Reconnect to prepare a link.');
			const args = { membershipId: this.membershipId, id: this.id };
			let link: Link | null = null;
			if (!this.operation) {
				const reservation = this.editors.reserveForLink(this.id);
				try {
					// Existing links remain copyable without flushing local edits.
					const needsSave = reservation.needsSave;
					if (needsSave)
						link = await waitForRead(
							this.client.query(api.buyerLinks.latest, args),
							deadline.signal
						);
					if (!link) {
						let preparation: Capture['args']['preparation'] = { kind: 'saved' };
						if (needsSave || reservation.needsSave) {
							this.busy = 'Saving changes…';
							const editor = reservation.editor;
							if (
								(editor.error && !(await waitForRead(editor.initialize(), deadline.signal))) ||
								!(await waitForRead(editor.savePending(), deadline.signal)) ||
								!editor.persistence ||
								reservation.needsSave
							)
								throw new ConvexError('Resolve unsaved changes before creating a link.');
							preparation = {
								kind: 'flushed',
								expectedEditRevision: editor.persistence.confirmed.editRevision
							};
						}
						if (!this.alive) return;
						this.operation = {
							args: {
								...args,
								preparation
							}
						};
					}
				} finally {
					reservation.release();
				}
			}
			link ??= await this.confirmCapture(deadline.signal);
			if (!this.alive) return;
			const url = `${location.origin}${buyerPath(link.token)}`;
			await this.copyToClipboard(url);
			// Delivery, including the manual-copy fallback, completes this capture intent.
			this.operation = undefined;
		} catch (error) {
			if (this.alive) this.error = saveError(error, 'We couldn’t prepare the link. Try again.');
		} finally {
			deadline.complete();
			if (this.alive) this.busy = null;
		}
	}
	private async confirmCapture(signal: AbortSignal) {
		const operation = this.operation;
		if (!operation) throw new ConvexError('This contract is unavailable.');
		if (operation.link) return operation.link;
		this.busy = 'Creating link…';
		const work = (operation.work ??= this.client
			.action(api.buyerLinkActions.ensureLatest, operation.args)
			.then(
				(link) => {
					if (this.operation === operation) operation.link = link;
					return link;
				},
				(error: unknown) => {
					if (this.operation === operation) this.operation = undefined;
					throw error;
				}
			));
		// A local timeout must not discard the request or ignore a late acknowledgement.
		return await waitForRead(work, signal);
	}
	private async copyToClipboard(url: string) {
		try {
			await navigator.clipboard.writeText(url);
		} catch {
			if (this.alive) this.manualUrl = url;
			return;
		}
		// Every copy action uses the workspace confirmation after the clipboard accepts the URL.
		if (this.alive) this.onCopied();
		// Setup progress must not delay confirmation or turn a successful copy into an error.
		journalBuyerLinkCopy(this.membershipId);
		void flushBuyerLinkCopy(this.client, this.membershipId);
	}
}
