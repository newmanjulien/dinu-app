import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

/** Keep the claimed hint visible for this dashboard visit, including viewer remounts. */
export class FirstLinkHintVisit {
	shown = $state(false);
	private requested = false;
	readonly visitId = crypto.randomUUID();

	constructor(readonly membershipId: Id<'memberships'>) {}

	claim(client: Pick<ConvexClient, 'mutation'>) {
		if (this.requested) return;
		this.requested = true;
		void client
			.mutation(api.buyerLinkPresentation.claimFirstBuyerLinkHintShowing, {
				membershipId: this.membershipId,
				visitId: this.visitId
			})
			.then((shown) => {
				this.shown = shown;
			})
			.catch(() => {
				// A later dashboard refresh can retry with the same visit ID.
				this.requested = false;
			});
	}
}
