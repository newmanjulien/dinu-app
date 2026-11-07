import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import { ConvexError } from 'convex/values';
import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

type Ack = { id: Id<'hubspotExports'>; initiatedAt: number; retryAt?: number };
const memory = new Map<string, Ack>(),
	running = new Set<string>();
function prefix(member: string) {
	return `dinu:download-acks:${env.PUBLIC_CONVEX_URL}:${member}:`;
}
function read(member: string) {
	const name = prefix(member),
		rows = new Map(
			[...memory].filter(([key]) => key.startsWith(name)).map(([, value]) => [value.id, value])
		);
	try {
		// Snapshot before removing malformed keys; localStorage indices shift after deletion.
		const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter(
			(key): key is string => Boolean(key?.startsWith(name))
		);
		for (const key of keys) {
			try {
				const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
				if (
					!value ||
					typeof value !== 'object' ||
					!('id' in value) ||
					typeof value.id !== 'string' ||
					!/^[a-z0-9]{20,64}$/.test(value.id) ||
					key !== name + value.id ||
					!('initiatedAt' in value) ||
					typeof value.initiatedAt !== 'number' ||
					!Number.isFinite(value.initiatedAt) ||
					('retryAt' in value &&
						(typeof value.retryAt !== 'number' || !Number.isFinite(value.retryAt)))
				)
					throw new Error('Malformed acknowledgment');
				rows.set(value.id as Ack['id'], value as Ack);
			} catch {
				try {
					localStorage.removeItem(key);
				} catch {
					/* Keep processing other keys. */
				}
			}
		}
	} catch {
		/* Memory preserves acknowledgments when storage is unavailable. */
	}
	return [...rows.values()];
}
function remove(member: string, id: Ack['id']) {
	const key = prefix(member) + id;
	memory.delete(key);
	try {
		localStorage.removeItem(key);
	} catch {
		/* Replaying an old disk entry is harmless. */
	}
}
/** Each attempt has its own storage key: concurrent tabs cannot overwrite another download. */
export function journalDownload(
	member: Id<'memberships'>,
	id: Id<'hubspotExports'>,
	initiatedAt: number
) {
	if (!browser) return;
	const key = prefix(member) + id,
		value = { id, initiatedAt };
	memory.set(key, value);
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* Recovery cannot be guaranteed when browser storage is unavailable. */
	}
}
export async function flushDownloadAcks(
	client: Pick<ConvexClient, 'mutation'>,
	member: Id<'memberships'>
) {
	if (!browser || running.has(member)) return;
	running.add(member);
	try {
		for (const row of read(member)
			.filter((row) => row.initiatedAt <= Date.now() + 60_000 && (row.retryAt ?? 0) <= Date.now())
			.slice(0, 25)) {
			try {
				await client.mutation(api.hubspotExports.acknowledge, {
					membershipId: member,
					id: row.id,
					initiatedAt: row.initiatedAt
				});
				remove(member, row.id);
			} catch (error) {
				if (error instanceof ConvexError) {
					const data: unknown = error.data;
					if (
						data === 'This download is unavailable.' ||
						data === 'Invalid download acknowledgment.' ||
						(typeof data === 'object' &&
							data !== null &&
							'code' in data &&
							data.code === 'DOWNLOAD_ACK_TERMINAL')
					) {
						remove(member, row.id);
						continue;
					}
					if (
						typeof data === 'object' &&
						data !== null &&
						'code' in data &&
						data.code === 'DOWNLOAD_ACK_FUTURE'
					) {
						const delay =
							'retryAfter' in data &&
							typeof data.retryAfter === 'number' &&
							Number.isFinite(data.retryAfter)
								? Math.min(24 * 60 * 60_000, Math.max(1000, data.retryAfter))
								: 60_000;
						const deferred = { ...row, retryAt: Date.now() + delay };
						const key = prefix(member) + row.id;
						memory.set(key, deferred);
						try {
							localStorage.setItem(key, JSON.stringify(deferred));
						} catch {
							/* Keep memory deferral. */
						}
						continue;
					}
				}
				break;
			}
		}
	} finally {
		running.delete(member);
	}
}
