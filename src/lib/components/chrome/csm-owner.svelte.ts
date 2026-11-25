import type { ConvexClient } from 'convex/browser';
import type { Id } from '../../../convex/_generated/dataModel';
import { api } from '../../../convex/_generated/api';
import {
	CsmAvailability,
	type AvailabilityLoad,
	type AvailabilitySelection
} from './csm-availability';
import { browserTimeZone } from './csm-time';
import type { CsmBookingMode, CsmReplacement } from './csm-booking';

export const initialAvailability = (mode: CsmBookingMode): AvailabilitySelection => ({
	mode,
	timeZone: browserTimeZone()
});

export type CsmOwner = {
	membershipId: Id<'memberships'>;
	availability: CsmAvailability;
	readonly unresolved: boolean;
	setUnresolved: (value: boolean) => void;
	canRead: (mode: CsmBookingMode, replacement?: CsmReplacement) => boolean;
	dispose: () => void;
};

export function createCsmOwner({
	client,
	membershipId,
	current,
	canRead,
	load
}: {
	client: Pick<ConvexClient, 'action'>;
	membershipId: Id<'memberships'>;
	current: () => boolean;
	canRead: (mode: CsmBookingMode, replacement?: CsmReplacement) => boolean;
	load?: (selection: AvailabilitySelection) => Promise<AvailabilityLoad | undefined>;
}): CsmOwner {
	let unresolved = $state(false);
	const availability = new CsmAvailability(async (selection) => {
		if (!canRead(selection.mode, selection.replacement)) throw new Error('Booking access changed.');
		const cached = await load?.(selection);
		if (cached) return cached;
		return client.action(api.csmBookings.availability, { membershipId, ...selection });
	}, current);
	return {
		membershipId,
		availability,
		get unresolved() {
			return unresolved;
		},
		setUnresolved(value) {
			unresolved = value;
		},
		canRead,
		dispose() {
			availability.dispose();
		}
	};
}
