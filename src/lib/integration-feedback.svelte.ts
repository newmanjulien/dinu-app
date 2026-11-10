import { getContext, setContext } from 'svelte';
import type { Id } from '../convex/_generated/dataModel';
import type { HubSpotDeals } from './hubspot-deals.svelte';

/** Uninstall feedback outlives its page, but never its workspace. */
export class IntegrationFeedback {
	confirmation = $state.raw<{ message: string } | null>(null);
	private removal = $state.raw<{
		id: Id<'hubspotRemovals'>;
		connectionId: Id<'hubspotConnections'>;
	} | null>(null);
	private quotesRemoval = $state.raw<{
		id: Id<'hubspotQuoteInstallations'>;
		epoch: number;
		connectionId: Id<'hubspotConnections'>;
	} | null>(null);
	private timer: ReturnType<typeof setTimeout> | undefined;
	private alive = true;

	trackRemoval(id: Id<'hubspotRemovals'>, connectionId: Id<'hubspotConnections'>) {
		if (this.alive) this.removal = { id, connectionId };
	}

	trackQuotesRemoval(
		id: Id<'hubspotQuoteInstallations'>,
		epoch: number,
		connectionId: Id<'hubspotConnections'>
	) {
		if (this.alive) this.quotesRemoval = { id, epoch, connectionId };
	}

	observe(connection: HubSpotDeals['connection']['data']) {
		if (!this.alive || !connection) return;
		const tracked = this.removal;
		// A newer installation supersedes this removal, even if its completion was missed.
		if (tracked && connection.connectionId && connection.connectionId !== tracked.connectionId) {
			this.removal = null;
		} else if (tracked && connection.removal?.id === tracked.id && connection.removal.done) {
			this.removal = null;
			this.show(
				connection.removal.provider === 'confirmed' ? 'HubSpot uninstalled' : 'HubSpot disconnected'
			);
		}

		const quotesRemoval = this.quotesRemoval;
		if (!quotesRemoval) return;
		const quotes = connection.quotes;
		if (
			connection.connectionId !== quotesRemoval.connectionId ||
			quotes.installationId !== quotesRemoval.id
		) {
			this.quotesRemoval = null;
			return;
		}
		if (quotes.epoch <= quotesRemoval.epoch) return;
		this.quotesRemoval = null;
		// Uninstall advances the epoch once; another installation supersedes that completion.
		if (quotes.epoch === quotesRemoval.epoch + 1 && !quotes.installed)
			this.show('HubSpot Quotes uninstalled');
	}

	private show(message: string) {
		if (!this.alive) return;
		clearTimeout(this.timer);
		this.confirmation = { message };
		this.timer = setTimeout(() => (this.confirmation = null), 2500);
	}

	destroy() {
		this.alive = false;
		clearTimeout(this.timer);
		this.removal = null;
		this.quotesRemoval = null;
		this.confirmation = null;
	}
}

const key = Symbol('integration-feedback');
export const setIntegrationFeedback = () => setContext(key, new IntegrationFeedback());
export const getIntegrationFeedback = () => getContext<IntegrationFeedback>(key);
