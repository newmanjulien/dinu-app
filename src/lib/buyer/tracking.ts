import type { Infer } from 'convex/values';
import type { activityRequest } from './activity-transport';

export const DAY = 86_400_000;
export const ACTIVITY_RETENTION = 30 * DAY;
export const validTrackingId = (value: string) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);

export type BuyerActivityRequest = Infer<typeof activityRequest>;
export type ActivityBrowser = { browserId: string; expiresAt: number } | null;
