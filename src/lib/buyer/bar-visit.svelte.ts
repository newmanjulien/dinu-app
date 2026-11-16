import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

/** The route owns this visit across viewer remounts and link status changes. */
export class BuyerLinkBarVisit {
	shown = $state(false);
	private requested = false;
	readonly visitId = crypto.randomUUID();

	constructor(
		readonly contractId: Id<'savedContracts'>,
		readonly membershipId: Id<'memberships'>
	) {}

	claim(client: Pick<ConvexClient, 'mutation'>) {
		if (this.requested) return;
		this.requested = true;
		void client
			.mutation(api.buyerLinkPresentation.claimBuyerLinkBarShowing, {
				membershipId: this.membershipId,
				contractId: this.contractId,
				visitId: this.visitId
			})
			.then((shown) => {
				this.shown = shown;
			})
			.catch(() => {
				// A later status refresh can retry with the same visit ID.
				this.requested = false;
			});
	}
}
