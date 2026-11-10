import type { ConvexClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';

type Result = FunctionReturnType<typeof api.hubspotRecipients.resolve>;
export type RecipientTarget = NonNullable<Result['target']>;
const freshness = 45_000;

/** One open contract owns its display observation; nothing enters saved or recovery state. */
export class HubSpotRecipient {
	private observation = $state.raw<{ owner: string; name: string | null; at: number }>();
	private owner: string | null = null;
	private request: object | undefined;
	private retryAt = 0;
	private destroyed = false;

	constructor(
		private readonly options: {
			client: Pick<ConvexClient, 'action'>;
			membershipId: Id<'memberships'>;
			contractId: Id<'savedContracts'>;
			owner: () => { key: string; target: RecipientTarget } | null;
		}
	) {}

	get name() {
		return !this.destroyed && this.observation?.owner === this.options.owner()?.key
			? this.observation?.name
			: null;
	}

	align(owner: string | null) {
		if (this.owner === owner) return;
		this.owner = owner;
		this.observation = undefined;
		this.request = undefined;
		this.retryAt = 0;
	}

	async refresh() {
		if (this.destroyed) return;
		const owner = this.options.owner();
		this.align(owner?.key ?? null);
		if (
			!owner ||
			this.request ||
			Date.now() < this.retryAt ||
			(this.observation && Date.now() - this.observation.at < freshness)
		)
			return;
		this.observation = undefined;
		const request = {};
		this.request = request;
		const current = () =>
			!this.destroyed && this.options.owner()?.key === owner.key && this.request === request;
		try {
			const result = await this.options.client.action(api.hubspotRecipients.resolve, {
				membershipId: this.options.membershipId,
				contractId: this.options.contractId
			});
			if (!current()) return;
			const target = result.target;
			if (
				!target ||
				target.connectionId !== owner.target.connectionId ||
				target.accountId !== owner.target.accountId ||
				target.dealId !== owner.target.dealId ||
				target.generation !== owner.target.generation ||
				target.installedAt !== owner.target.installedAt
			) {
				this.retryAt = Date.now() + 15_000;
				return;
			}
			if (result.outcome === 'resolved' || result.outcome === 'empty')
				this.observation = {
					owner: owner.key,
					name: result.company?.name ?? null,
					at: Date.now()
				};
			else
				this.retryAt =
					Date.now() +
					(result.outcome === 'missing-capability'
						? freshness
						: Math.min(300_000, Math.max(2000, result.retryAfter || 15_000)));
		} catch {
			if (current()) this.retryAt = Date.now() + 15_000;
		} finally {
			if (this.request === request) this.request = undefined;
		}
	}

	destroy() {
		this.destroyed = true;
		this.align(null);
	}
}
