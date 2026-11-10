import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

const pending = new Set<string>();
const running = new Set<string>();
const key = (member: Id<'memberships'>) =>
	`dinu:buyer-link-copy:${env.PUBLIC_CONVEX_URL}:${member}`;

/** Retain the clipboard success until its idempotent membership milestone is acknowledged. */
export function journalBuyerLinkCopy(member: Id<'memberships'>) {
	if (!browser) return;
	const name = key(member);
	pending.add(name);
	try {
		localStorage.setItem(name, 'pending');
	} catch {
		/* Memory retains progress for this page lifetime when browser storage is unavailable. */
	}
}

/** Called immediately after copy and by the workspace's existing acknowledgment retry loop. */
export async function flushBuyerLinkCopy(
	client: Pick<ConvexClient, 'mutation'>,
	member: Id<'memberships'>
) {
	if (!browser) return;
	const name = key(member);
	if (running.has(name)) return;
	let queued = pending.has(name);
	try {
		queued ||= localStorage.getItem(name) === 'pending';
	} catch {
		/* The in-memory marker remains usable. */
	}
	if (!queued) return;
	pending.add(name);
	running.add(name);
	try {
		await client.mutation(api.accounts.recordBuyerLinkCopy, { membershipId: member });
		pending.delete(name);
		try {
			localStorage.removeItem(name);
		} catch {
			/* Replaying this one-time milestone is harmless. */
		}
	} catch {
		/* Keep the marker for the next workspace retry, reload, or sign-in. */
	} finally {
		running.delete(name);
	}
}
