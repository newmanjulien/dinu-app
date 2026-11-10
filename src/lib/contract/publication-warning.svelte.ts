import { ConvexError } from 'convex/values';
import type { ConvexClient } from 'convex/browser';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { saveError } from './saved';

export function publicationConfirmationRequired(error: unknown) {
	return (
		error instanceof ConvexError &&
		typeof error.data === 'object' &&
		error.data !== null &&
		'code' in error.data &&
		error.data.code === 'PUBLICATION_CONFIRMATION_REQUIRED'
	);
}
/** The original closure retains the application identity through modal confirmation. */
export class PublicationWarning {
	pending = $state.raw<{ label: string; run: () => Promise<void> } | null>(null);
	busy = $state(false);
	error = $state<string | null>(null);
	private alive = true;
	constructor(
		private client: Pick<ConvexClient, 'query' | 'mutation'>,
		private membershipId: Id<'memberships'>,
		private id: Id<'savedContracts'>
	) {}
	async run(label: string, action: () => Promise<void>) {
		if (!this.alive || this.pending) return;
		try {
			const warning = await this.client.query(api.buyerLinks.warning, {
				membershipId: this.membershipId,
				id: this.id
			});
			if (!this.alive) return;
			if (warning.published && !warning.acknowledged) {
				this.pending = { label, run: action };
				this.error = null;
				return;
			}
			await action();
		} catch (error) {
			if (!this.alive) return;
			if (publicationConfirmationRequired(error)) {
				this.pending = { label, run: action };
				this.error = null;
			} else throw error;
		}
	}
	request(label: string, action: () => Promise<void>) {
		if (this.alive && !this.pending) {
			this.pending = { label, run: action };
			this.error = null;
		}
	}
	cancel() {
		if (!this.busy) {
			this.pending = null;
			this.error = null;
		}
	}
	async confirm() {
		const intent = this.pending;
		if (!intent || this.busy) return;
		this.busy = true;
		this.error = null;
		try {
			await this.client.mutation(api.buyerLinks.acknowledge, {
				membershipId: this.membershipId,
				id: this.id
			});
			if (!this.alive) return;
			await intent.run();
			if (this.alive && this.pending === intent) this.pending = null;
		} catch (error) {
			if (this.alive) this.error = saveError(error, 'We couldn’t continue. Try again.');
		} finally {
			this.busy = false;
		}
	}
	destroy() {
		this.alive = false;
		this.pending = null;
	}
}
