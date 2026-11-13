import { getContext, setContext } from 'svelte';
import { useConvexClient } from 'convex-svelte';
import type { Id } from '../../../convex/_generated/dataModel';
import { api } from '../../../convex/_generated/api';
import { CsmAvailability, type CalendarSelection } from './csm-availability';
import { browserTimeZone, localDate } from './csm-calendar';
import type { CsmBookingMode, CsmReplacement } from './csm-booking';
import { loadCsmModal } from './csm-modal';
import type { SupportContent } from './csm-support';

export const initialCalendar = (mode: CsmBookingMode): CalendarSelection => {
	const timeZone = browserTimeZone();
	return { mode, timeZone, month: localDate(new Date(), timeZone).slice(0, 7) };
};
export type CsmOwner = {
	membershipId: Id<'memberships'>;
	calendar: CsmAvailability;
	readonly unresolved: boolean;
	setUnresolved: (value: boolean) => void;
	canRead: (mode: CsmBookingMode, replacement?: CsmReplacement) => boolean;
};
export type CsmAccess = {
	identity: string;
	membershipId: Id<'memberships'>;
	manageSetup: boolean;
};
const key = Symbol('csm-preload');
export function setCsmPreload(
	canStart: () => boolean,
	setupBooked: () => boolean,
	access: () => CsmAccess | undefined
) {
	const client = useConvexClient();
	let owner = $state<CsmOwner>();
	let poster = $state<string>();
	let videoPrepared = $state(false);
	let identity: string | undefined;
	const liveIdentity = () => access()?.identity;
	function align() {
		const next = liveIdentity();
		if (next !== identity) {
			owner?.calendar.dispose();
			owner = undefined;
			poster = undefined;
			videoPrepared = false;
			identity = next;
			if (next) {
				const membershipId = access()!.membershipId;
				let unresolved = $state(false);
				const current = () => identity === next && liveIdentity() === next;
				owner = {
					membershipId,
					calendar: new CsmAvailability((selection) => {
						if (!owner?.canRead(selection.mode, selection.replacement))
							throw new Error('Booking access changed.');
						return client.action(api.csmBookings.availability, { membershipId, ...selection });
					}, current),
					get unresolved() {
						return unresolved;
					},
					setUnresolved: (value) => {
						unresolved = value;
					},
					canRead: (mode, replacement) =>
						current() &&
						(mode === 'setup' ? (!!replacement || !setupBooked()) && !!access()?.manageSetup : true)
				};
			}
		}
		return owner;
	}
	function warm(
		target: CalendarSelection | CsmBookingMode,
		{ video }: { video?: SupportContent['video'] } = {}
	) {
		try {
			const selection = typeof target === 'string' ? initialCalendar(target) : target;
			const active = align();
			if (!active?.canRead(selection.mode, selection.replacement) || !canStart()) return;
			if (video) {
				poster = video.poster;
				videoPrepared = true;
			}
			void loadCsmModal().catch(() => {});
			// Replacement availability requires the picker's live appointment-status check.
			if (!selection.replacement && !active.unresolved)
				void active.calendar.read(selection).catch(() => {});
		} catch {
			/* Optional work cannot interrupt focus or navigation. */
		}
	}
	const value = {
		align,
		warm,
		get poster() {
			return poster;
		},
		get videoPrepared() {
			return videoPrepared;
		},
		get owner() {
			return owner;
		},
		dispose() {
			owner?.calendar.dispose();
			owner = undefined;
			poster = undefined;
			videoPrepared = false;
			identity = undefined;
		}
	};
	return setContext(key, value);
}
export const useCsmPreload = () => getContext<ReturnType<typeof setCsmPreload>>(key);
