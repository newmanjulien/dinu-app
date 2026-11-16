import { withinBookingWindow } from '$lib/booking-window';
import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../../convex/_generated/api';
import type { CsmBookingMode, CsmReplacement } from './csm-booking';

export type Availability = FunctionReturnType<typeof api.csmBookings.availability>;
export type AvailabilitySelection = {
	mode: CsmBookingMode;
	timeZone: string;
	replacement?: CsmReplacement;
};
export type AvailabilityLoad = Availability | { data: Availability; expiresAt: number };
type Entry = { pending: Promise<Availability>; data?: Availability; expires?: number };
const keyFor = (selection: AvailabilitySelection) =>
	JSON.stringify([
		selection.mode,
		selection.replacement?.appointmentId,
		selection.replacement?.currentUid,
		selection.timeZone
	]);
const future = (data: Availability): Availability => {
	const now = Date.now();
	return { ...data, slots: data.slots.filter((slot) => withinBookingWindow(slot.start, now)) };
};

/** One live workspace's display reads. Cancelling a UI waiter does not cancel accepted work. */
export class CsmAvailability {
	private entries = new Map<string, Entry>();
	private alive = true;
	constructor(
		private load: (selection: AvailabilitySelection) => Promise<AvailabilityLoad>,
		readonly current: () => boolean
	) {}
	private entry(selection: AvailabilitySelection) {
		if (!this.alive || !this.current()) return;
		const key = keyFor(selection),
			entry = this.entries.get(key);
		if (entry?.expires !== undefined && entry.expires <= Date.now()) {
			this.entries.delete(key);
			return;
		}
		if (entry) {
			this.entries.delete(key);
			this.entries.set(key, entry);
		}
		return entry;
	}
	expiresAt(selection: AvailabilitySelection) {
		return this.entry(selection)?.expires;
	}
	peek(selection: AvailabilitySelection) {
		const data = this.entry(selection)?.data;
		return data && future(data);
	}
	read(selection: AvailabilitySelection): Promise<Availability> {
		if (!this.alive || !this.current()) return Promise.reject(new Error('Workspace changed.'));
		const cached = this.entry(selection);
		if (cached) return cached.pending.then(future);
		const key = keyFor(selection);
		const loading = Promise.resolve().then(() => {
			if (!this.alive || !this.current()) throw new Error('Workspace changed.');
			return this.load(selection);
		});
		const entry: Entry = {
			pending: loading.then(
				(result) => {
					const { data, expiresAt } =
						'data' in result ? result : { data: result, expiresAt: undefined };
					if (this.entries.get(key) === entry) {
						if (this.alive && this.current() && data.status === 'ready') {
							const expires = Math.min(Date.now() + 120_000, expiresAt ?? Infinity);
							if (expires > Date.now()) {
								entry.data = data;
								entry.expires = expires;
							} else this.entries.delete(key);
						} else this.entries.delete(key);
					}
					return data;
				},
				(error: unknown) => {
					if (this.entries.get(key) === entry) this.entries.delete(key);
					throw error;
				}
			)
		};
		this.entries.set(key, entry);
		while (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
		return entry.pending.then(future);
	}
	invalidate() {
		this.entries.clear();
	}
	dispose() {
		this.alive = false;
		this.invalidate();
	}
}
