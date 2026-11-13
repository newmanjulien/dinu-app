import { ConvexError } from 'convex/values';
import type { ConvexClient } from 'convex/browser';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import type { ContractEditors } from '$lib/contract/editors.svelte';
import { saveError } from '$lib/contract/saved';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import { buyerPath } from './urls';

type Link = FunctionReturnType<typeof api.buyerLinkActions.ensureLatest>;
type Capture = {
	args: FunctionArgs<typeof api.buyerLinkActions.ensureLatest>;
	link?: Link;
	work?: Promise<Link>;
};

/** Permanent-link preparation for copying buyer links. */
export class BuyerLinkController {
	busy = $state<string | null>(null);
	error = $state<string | null>(null);
	private operation: Capture | undefined;
	private alive = true;
	constructor(
		private client: Pick<ConvexClient, 'query' | 'action' | 'connectionState'>,
		private editors: Pick<ContractEditors, 'reserveForLink'>,
		private membershipId: Id<'memberships'>,
		private id: Id<'savedContracts'>,
		private onCopied: () => void
	) {}
	destroy() {
		this.alive = false;
		this.operation = undefined;
	}
	async copy() {
		await this.withLink(async (link) => {
			await this.copyToClipboard(`${location.origin}${buyerPath(link.token)}`);
		});
	}
	private async withLink(complete: (link: Link) => void | Promise<void>) {
		if (this.busy || !this.alive) return;
		this.error = null;
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
					// Resolve a permanent link before touching any local editor or publication state.
					link = await waitForRead(this.client.query(api.buyerLinks.latest, args), deadline.signal);
					if (!link) {
						if (reservation.needsSave) {
							this.busy = 'Saving changes…';
							if (!(await waitForRead(reservation.editor.savePending(), deadline.signal)))
								throw new ConvexError('Resolve unsaved changes before continuing.');
						}
						if (!this.alive) return;
						if (reservation.needsSave)
							throw new ConvexError('Resolve unsaved changes before continuing.');
						const readiness = await waitForRead(
							this.client.query(api.contracts.readiness, args),
							deadline.signal
						);
						if (reservation.needsSave)
							throw new ConvexError('Resolve unsaved changes before continuing.');
						if (!readiness?.ready)
							throw new ConvexError(
								'Save this contract and approve all required changes before continuing.'
							);
						const expectedState = readiness.expectation;
						if (!this.alive) return;
						this.operation = {
							args: {
								...args,
								preparation: { kind: 'prepared', expectedState, operationId: crypto.randomUUID() }
							}
						};
					}
				} finally {
					reservation.release();
				}
			}
			link ??= await this.confirmCapture(deadline.signal);
			if (!this.alive) return;
			await complete(link);
			// Only the requested completion action consumes this capture.
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
		const work: Promise<Link> = this.client
			.action(api.buyerLinkActions.ensureLatest, operation.args)
			.then(
				(link) => {
					if (this.operation === operation) operation.link ??= link;
					return link;
				},
				(error: unknown) => {
					if (
						error instanceof ConvexError &&
						this.operation === operation &&
						operation.work === work &&
						!operation.link
					)
						this.operation = undefined;
					throw error;
				}
			);
		operation.work = work;
		// Each click retries the request; late successes stay cached without copying automatically.
		return await waitForRead(work, signal);
	}
	private async copyToClipboard(url: string) {
		try {
			await navigator.clipboard.writeText(url);
		} catch {
			throw new ConvexError('Couldn’t copy the link. Try again.');
		}
		// Every copy action uses the workspace confirmation after the clipboard accepts the URL.
		if (this.alive) this.onCopied();
	}
}
