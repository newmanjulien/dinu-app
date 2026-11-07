/** Date-only arithmetic uses UTC; booked instants are always formatted in the selected IANA zone. */
function dateKey(date: Date) {
	return date.toISOString().slice(0, 10);
}
export function dateValue(key: string) {
	return new Date(key + 'T12:00:00Z');
}
export function addDays(key: string, days: number) {
	const date = dateValue(key);
	date.setUTCDate(date.getUTCDate() + days);
	return dateKey(date);
}
export function addMonths(key: string, months: number) {
	const date = dateValue(key),
		day = date.getUTCDate();
	date.setUTCDate(1);
	date.setUTCMonth(date.getUTCMonth() + months);
	const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
	date.setUTCDate(Math.min(day, last));
	return dateKey(date);
}
export function grid(month: string) {
	const first = month + '-01';
	const start = addDays(first, -dateValue(first).getUTCDay());
	return Array.from({ length: 6 }, (_, week) =>
		Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day))
	).filter((week) => week.some((date) => date.startsWith(month)));
}
function dateInZone(timeZone: string) {
	const formatter = new Intl.DateTimeFormat('en', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	});
	return (instant: string | Date) => {
		const parts = formatter.formatToParts(new Date(instant));
		return ['year', 'month', 'day']
			.map((type) => parts.find((p) => p.type === type)!.value)
			.join('-');
	};
}
export function localDate(instant: string | Date, timeZone: string) {
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
export function timeLabel(start: string, timeZone: string) {
	return new Intl.DateTimeFormat(undefined, { ...timeFormat, timeZone }).format(new Date(start));
}
