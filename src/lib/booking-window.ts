export const BOOKING_WINDOW_MS = 48 * 60 * 60 * 1000;

/** The window limits appointment starts; the meeting may end beyond it. */
export function withinBookingWindow(start: string, now: number) {
	const instant = Date.parse(start);
	return instant > now && instant <= now + BOOKING_WINDOW_MS;
}
