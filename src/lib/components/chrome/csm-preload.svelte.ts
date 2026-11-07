import { getContext, setContext } from 'svelte';
import { useConvexClient } from 'convex-svelte';
import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
import { api } from '../../../convex/_generated/api';
import { CsmAvailability, type CalendarSelection } from './csm-availability';
import { browserTimeZone, localDate } from './csm-calendar';
import type { CsmBookingMode, CsmReplacement } from './csm-booking';
import { loadCsmModal } from './csm-modal';

export const initialCalendar = (mode: CsmBookingMode): CalendarSelection => {
	const timeZone = browserTimeZone();
	return { mode, timeZone, month: localDate(new Date(), timeZone).slice(0, 7) };
};
export type CsmOwner = {
	calendar: CsmAvailability;
	unresolved: boolean;
	uploadWarmed: boolean;
	canRead: (mode: CsmBookingMode, replacement?: CsmReplacement) => boolean;
};
const key = Symbol('csm-preload');
export function setCsmPreload(canStart: () => boolean, setupBooked: () => boolean) {
	const viewer = useViewer(),
		session = useViewerSession(),
		client = useConvexClient();
	let owner = $state<CsmOwner>();
	let identity: string | undefined;
	const liveIdentity = () => {
		const v = viewer();
		return !session.blocked &&
			!session.closing &&
			session.preparedSessionId &&
			!v.company.deletionPending &&
			(setupBooked() || v.permissions.manageTemplate)
			? JSON.stringify([
					session.preparedSessionId,
					session.transportGeneration,
					v.profile.id,
					v.membership.id,
					v.company.id
				])
			: undefined;
	};
	function align() {
		const next = liveIdentity();
		if (next !== identity) {
			owner?.calendar.dispose();
			owner = undefined;
			identity = next;
			if (next) {
				const membershipId = viewer().membership.id;
				const current = () => identity === next && liveIdentity() === next;
				owner = {
					calendar: new CsmAvailability((selection) => {
						if (!owner?.canRead(selection.mode, selection.replacement))
							throw new Error('Booking access changed.');
						return client.action(api.csmBookings.availability, { membershipId, ...selection });
					}, current),
					unresolved: false,
					uploadWarmed: false,
					canRead: (mode, replacement) =>
						current() &&
						(mode === 'setup'
							? (!!replacement || !setupBooked()) && viewer().permissions.manageTemplate
							: setupBooked())
				};
			}
		}
		return owner;
	}
	function warm(target: CalendarSelection | CsmBookingMode, upload = false) {
		try {
			const selection = typeof target === 'string' ? initialCalendar(target) : target;
			const active = align();
			if (!active?.canRead(selection.mode, selection.replacement) || !canStart()) return;
			if (upload && active.uploadWarmed) return;
			if (upload) active.uploadWarmed = true;
			void loadCsmModal().catch(() => {});
			if (!active.unresolved) void active.calendar.read(selection).catch(() => {});
		} catch {
			/* Optional work cannot interrupt upload, focus or navigation. */
		}
	}
	const value = {
		align,
		warm,
		get owner() {
			return owner;
		},
		dispose() {
			owner?.calendar.dispose();
			owner = undefined;
			identity = undefined;
		}
	};
	return setContext(key, value);
}
export const useCsmPreload = () => getContext<ReturnType<typeof setCsmPreload>>(key);
