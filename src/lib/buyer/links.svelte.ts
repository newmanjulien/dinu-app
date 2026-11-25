import { ConvexError } from 'convex/values';
import type { ConvexClient } from 'convex/browser';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import type { ContractEditors } from '$lib/contract/editors.svelte';
import { contractReadiness } from '$lib/contract/changes';
import { IdempotentAction } from '$lib/contract/idempotent-action.svelte';
import { saveError } from '$lib/contract/saved';
import { waitForRead } from '$lib/auth/attempt';
import { buyerPath } from './urls';

type Link = NonNullable<FunctionReturnType<typeof api.buyerLinks.latest>>;
type CaptureArgs = FunctionArgs<typeof api.buyerLinks.ensureLatest>;
type CaptureResult = FunctionReturnType<typeof api.buyerLinks.ensureLatest>;

/** Permanent-link preparation for copying buyer links. */
export class BuyerLinkController {
	busy = $state<string | null>(null);
	error = $state<string | null>(null);
	private capture = new IdempotentAction<CaptureArgs, CaptureResult>({ cacheResult: true });
	private alive = true;
	constructor(
		private client: Pick<ConvexClient, 'query' | 'action' | 'connectionState'>,
		private editors: Pick<ContractEditors, 'reserveForLink'>,
		private membershipId: Id<'memberships'>,
		private id: Id<'savedContracts'>,
		private onCopied: (created: boolean) => void
	) {}
	destroy() {
		this.alive = false;
		this.capture.reset();
	}
	async copy() {
		if (this.busy || !this.alive) return;
		this.error = null;
		this.busy = 'Checking link…';
		try {
			if (!this.client.connectionState().isWebSocketConnected)
				throw new ConvexError('Reconnect to prepare a link.');
			const args = { membershipId: this.membershipId, id: this.id };
			let existingLink: Link | null = null;
			await this.capture.run({
				timeoutMs: 20_000,
				isCurrent: () => this.alive,
				prepare: async (signal) => {
					const reservation = this.editors.reserveForLink(this.id);
					try {
						const link = await waitForRead(this.client.query(api.buyerLinks.latest, args), signal);
						if (link) {
							existingLink = link;
							return null;
						}
						if (reservation.needsSave) {
							this.busy = 'Saving changes…';
							if (!(await waitForRead(reservation.editor.savePending(), signal)))
								throw new ConvexError('Resolve unsaved changes before continuing.');
						}
						if (!this.alive) return null;
						if (reservation.needsSave)
							throw new ConvexError('Resolve unsaved changes before continuing.');
						const state = await waitForRead(this.client.query(api.contracts.state, args), signal);
						if (reservation.needsSave)
							throw new ConvexError('Resolve unsaved changes before continuing.');
						if (!state || !contractReadiness(state.concessions, state.workBlock).ready)
							throw new ConvexError(
								'Approve or remove pending concessions before sharing a buyer link.'
							);
						if (!this.alive) return null;
						return {
							...args,
							operationId: crypto.randomUUID(),
							expectedStateRevision: state.stateRevision
						};
					} finally {
						reservation.release();
					}
				},
				onDispatch: () => {
					this.busy = 'Creating link…';
				},
				invoke: (captureArgs) => this.client.action(api.buyerLinks.ensureLatest, captureArgs),
				finish: async (link) => {
					await this.copyToClipboard(`${location.origin}${buyerPath(link.token)}`, link.created);
				}
			});
			if (existingLink && this.alive) {
				await this.copyToClipboard(
					`${location.origin}${buyerPath((existingLink as Link).token)}`,
					false
				);
			}
		} catch (error) {
			if (this.alive) this.error = saveError(error, 'We couldn’t prepare the link. Try again.');
		} finally {
			if (this.alive) this.busy = null;
		}
	}
	private async copyToClipboard(url: string, created: boolean) {
		try {
			await navigator.clipboard.writeText(url);
		} catch {
			throw new ConvexError(
				created
					? 'Link created, but couldn’t copy it. Try again.'
					: 'Couldn’t copy the link. Try again.'
			);
		}
		if (this.alive) this.onCopied(created);
	}
}
