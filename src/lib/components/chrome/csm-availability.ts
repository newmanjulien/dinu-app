import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../../convex/_generated/api';
import type { CsmBookingMode, CsmReplacement } from './csm-booking';

export type Availability = FunctionReturnType<typeof api.csmBookings.availability>;
export type CalendarSelection = {
	mode: CsmBookingMode;
	month: string;
	timeZone: string;
	replacement?: CsmReplacement;
};
type Entry = { pending: Promise<Availability>; data?: Availability; expires?: number };
const keyFor = (selection: CalendarSelection) =>
	JSON.stringify([
		selection.mode,
		selection.replacement?.appointmentId,
		selection.replacement?.currentUid,
		selection.month,
		selection.timeZone
	]);
const future = (data: Availability): Availability => ({
	...data,
	slots: data.slots.filter((slot) => Date.parse(slot.start) > Date.now())
});

/** One live workspace's display reads. Cancelling a UI waiter does not cancel accepted work. */
export class CsmAvailability {
	private entries = new Map<string, Entry>();
	private alive = true;
	constructor(
		private load: (selection: CalendarSelection) => Promise<Availability>,
		readonly current: () => boolean
	) {}
	private entry(selection: CalendarSelection) {
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
	peek(selection: CalendarSelection) {
		const data = this.entry(selection)?.data;
		return data && future(data);
	}
	read(selection: CalendarSelection): Promise<Availability> {
		if (!this.alive || !this.current()) return Promise.reject(new Error('Workspace changed.'));
		const cached = this.entry(selection);
		if (cached) return cached.pending.then(future);
		const key = keyFor(selection);
		const entry: Entry = {
			pending: Promise.resolve().then(() => {
				if (!this.alive || !this.current()) throw new Error('Workspace changed.');
				return this.load(selection);
			})
		};
		this.entries.set(key, entry);
		while (this.entries.size > 8) this.entries.delete(this.entries.keys().next().value!);
		entry.pending = entry.pending.then(
			(data) => {
				if (this.entries.get(key) === entry) {
					if (this.alive && this.current() && data.status === 'ready') {
						entry.data = data;
						entry.expires = Date.now() + 120_000;
					} else this.entries.delete(key);
				}
				return data;
			},
			(error: unknown) => {
				if (this.entries.get(key) === entry) this.entries.delete(key);
				throw error;
			}
		);
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
