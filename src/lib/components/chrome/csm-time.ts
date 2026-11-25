const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const MAX_LOCAL_DAY_MS = 26 * 60 * 60 * 1000;
const APPROX_HOUR_MAX_MS = 90 * MINUTE_MS;

/** Booked instants are formatted in the selected IANA time zone. */
function dateValue(key: string) {
	return new Date(key + 'T12:00:00Z');
}
function dayNumber(key: string) {
	const [year, month, day] = key.split('-').map(Number);
	return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}
function dateInZone(timeZone: string) {
	const formatter = new Intl.DateTimeFormat('en', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	return (instant: string | number | Date) => {
		const parts = formatter.formatToParts(new Date(instant));
		return ['year', 'month', 'day']
			.map((type) => parts.find((p) => p.type === type)!.value)
			.join('-');
	};
}
export function localDate(instant: string | number | Date, timeZone: string) {
	return dateInZone(timeZone)(instant);
}
const fullDateLabel = new Intl.DateTimeFormat(undefined, {
	weekday: 'long',
	month: 'long',
	day: 'numeric',
	year: 'numeric',
	timeZone: 'UTC'
});
export function dateLabel(key: string, options?: Intl.DateTimeFormatOptions) {
	return (
		options ? new Intl.DateTimeFormat(undefined, { ...options, timeZone: 'UTC' }) : fullDateLabel
	).format(dateValue(key));
}
export function groupSlots<T extends { start: string }>(slots: T[], timeZone: string) {
	const date = dateInZone(timeZone),
		grouped = new Map<string, T[]>();
	for (const slot of slots) {
		const key = date(slot.start),
			day = grouped.get(key) ?? [];
		day.push(slot);
		grouped.set(key, day);
	}
	return grouped;
}
const timeFormat: Intl.DateTimeFormatOptions = {
	hour: 'numeric',
	minute: '2-digit',
	hour12: true
};
/** Format once per day/zone; repeated DST wall times include their UTC offset. */
export function slotLabels(starts: string[], timeZone: string) {
	const formatter = new Intl.DateTimeFormat(undefined, { ...timeFormat, timeZone });
	const fullFormatter = new Intl.DateTimeFormat(undefined, {
		...timeFormat,
		timeZone,
		timeZoneName: 'shortOffset'
	});
	const counts = new Map<string, number>(),
		labels = new Map(starts.map((start) => [start, formatter.format(new Date(start))]));
	for (const label of labels.values()) counts.set(label, (counts.get(label) ?? 0) + 1);
	return new Map(
		starts.map((start) => {
			const label = labels.get(start)!,
				full = fullFormatter.format(new Date(start));
			return [start, { display: (counts.get(label) ?? 0) > 1 ? full : label, full }];
		})
	);
}
export function browserTimeZone() {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}
export function timeZones(current: string) {
	const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
	return [
		...new Set([current, 'UTC', ...(intl.supportedValuesOf?.('timeZone') ?? [current])])
	].sort();
}
/** The nearest start is labelled with its countdown once it is under an hour away. */
const UNTIL_BADGE_MS = 59 * 60_000;
/** Exact minute countdown for starts under an hour away; rounds up so a future start never reads
 * as zero. */
export function untilLabel(start: string, now: number) {
	const until = Date.parse(start) - now;
	if (until <= 0 || until > UNTIL_BADGE_MS) return;
	const minutes = Math.ceil(until / 60_000);
	return `${minutes} min${minutes === 1 ? '' : 's'}`;
}
/** Milliseconds until `untilLabel` next changes: entering the window, each minute boundary, then
 * expiry. */
export function untilLabelDelay(start: string, now: number) {
	const until = Date.parse(start) - now;
	if (until <= 0) return 0;
	if (until > UNTIL_BADGE_MS) return until - UNTIL_BADGE_MS;
	return until % 60_000 || 60_000;
}
export function timeLabel(start: string, timeZone: string) {
	return new Intl.DateTimeFormat(undefined, { ...timeFormat, timeZone }).format(new Date(start));
}
export type SetupCallSchedule = {
	relative: boolean;
	label: string;
};
/** Format a setup call start in English prose, using today/tomorrow by local calendar day. */
export function formatSetupCallSchedule(
	start: string,
	now: number,
	timeZone: string
): SetupCallSchedule {
	const date = dateInZone(timeZone);
	const diffDays = dayNumber(date(start)) - dayNumber(date(now));
	const instant = new Date(start);
	if (diffDays === 0 || diffDays === 1) {
		const time = new Intl.DateTimeFormat('en', { ...timeFormat, timeZone }).format(instant);
		return { relative: true, label: `${diffDays === 0 ? 'today' : 'tomorrow'} at ${time}` };
	}
	const label = new Intl.DateTimeFormat('en', {
		...timeFormat,
		timeZone,
		weekday: 'long',
		month: 'long',
		day: 'numeric'
	}).format(instant);
	return { relative: false, label };
}
/** Exact epoch millisecond when `localDate(t, timeZone)` next changes after `now`. */
export function nextLocalDayStart(now: number, timeZone: string) {
	const date = dateInZone(timeZone);
	const today = date(now);
	let lo = now;
	let hi = now + MAX_LOCAL_DAY_MS;
	while (date(hi) === today) {
		lo = hi;
		hi += MAX_LOCAL_DAY_MS;
	}
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (date(mid) === today) lo = mid;
		else hi = mid;
	}
	return hi;
}
/** Earliest epoch millisecond after `now` when a setup call banner's visibility or label can change. */
export function nextSetupCallUpdateAt(end: string, now: number, timeZone: string) {
	const endAt = Date.parse(end);
	if (!Number.isFinite(endAt) || endAt <= now) return null;
	return Math.min(endAt, nextLocalDayStart(now, timeZone));
}
/**
 * Conversational countdown phrase appended to "We can't wait to meet", or `null` once the call
 * has started or cannot be parsed.
 */
export function formatMeetingCountdown(
	start: string,
	now: number,
	timeZone: string
): string | null {
	const startAt = Date.parse(start);
	const until = startAt - now;
	if (!Number.isFinite(startAt) || until <= 0) return null;
	if (until <= UNTIL_BADGE_MS) {
		const minutes = Math.ceil(until / MINUTE_MS);
		return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
	}
	if (until <= APPROX_HOUR_MAX_MS) return 'in ~1h';
	const date = dateInZone(timeZone);
	const startDate = date(startAt);
	const nowDate = date(now);
	const diffDays = dayNumber(startDate) - dayNumber(nowDate);
	if (diffDays <= 0) return 'in a couple of hours';
	if (diffDays === 1) return 'tomorrow';
	const label = new Intl.DateTimeFormat('en', {
		timeZone,
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		...(startDate.slice(0, 4) !== nowDate.slice(0, 4) ? { year: 'numeric' } : {})
	}).format(new Date(startAt));
	return `on ${label}`;
}
/** Earliest epoch millisecond after `now` when `formatMeetingCountdown` can next change. */
export function nextMeetingCountdownUpdateAt(
	start: string,
	now: number,
	timeZone: string
): number | null {
	const startAt = Date.parse(start);
	const until = startAt - now;
	if (!Number.isFinite(startAt) || until <= 0) return null;
	if (until <= UNTIL_BADGE_MS) return now + (until % MINUTE_MS || MINUTE_MS);
	if (until <= APPROX_HOUR_MAX_MS) return startAt - UNTIL_BADGE_MS;
	const date = dateInZone(timeZone);
	const diffDays = dayNumber(date(startAt)) - dayNumber(date(now));
	if (diffDays <= 0) return startAt - APPROX_HOUR_MAX_MS;
	if (diffDays === 1)
		return Math.min(nextLocalDayStart(now, timeZone), startAt - APPROX_HOUR_MAX_MS);
	return nextLocalDayStart(now, timeZone);
}
