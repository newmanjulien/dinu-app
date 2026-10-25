export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 3;
export const DELEGATION_TIMEZONE = 'America/Toronto';
export const DOCX_CONTENT_TYPE =
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const PDF_CONTENT_TYPE = 'application/pdf';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
	timeZone: DELEGATION_TIMEZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit'
});

/** Calendar arithmetic in the delegate's timezone, independent of DST and client timezone. */
export function delegationDeadline(timestamp: number, businessDays: number): string {
	const parts = dateFormatter.formatToParts(timestamp);
	const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
	const date = new Date(Date.UTC(part('year'), part('month') - 1, part('day')));
	for (let remaining = businessDays; remaining > 0;) {
		date.setUTCDate(date.getUTCDate() + 1);
		if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) remaining--;
	}
	return date.toISOString().slice(0, 10);
}

export function formatDelegationDeadline(date: string): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'UTC',
		weekday: 'long',
		month: 'long',
		day: 'numeric',
		year: 'numeric'
	}).format(new Date(`${date}T12:00:00Z`));
}

/** Find the next local date boundary, including Toronto's 23/25-hour DST days. */
export function nextDelegationMidnight(timestamp: number): number {
	const today = delegationDeadline(timestamp, 0);
	let lower = Math.floor(timestamp);
	let upper = lower + 26 * 60 * 60_000;
	while (upper - lower > 1) {
		const middle = Math.floor((lower + upper) / 2);
		if (delegationDeadline(middle, 0) === today) lower = middle;
		else upper = middle;
	}
	return upper;
}
