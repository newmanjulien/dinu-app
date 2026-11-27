import { env } from '$env/dynamic/public';
import type { Id } from '../../convex/_generated/dataModel';
import { deletePersistentCache } from '$lib/auth/persistent-cache-registry';

export type CacheScope = Readonly<{
	namespace: string;
	userId: string | null;
	membershipId: Id<'memberships'> | null;
}>;
export function createCacheScope(
	identity: { userId: string; profileId: Id<'profiles'>; membershipId: Id<'memberships'> } | null
): CacheScope {
	return Object.freeze({
		namespace: `dinu:v9:${env.PUBLIC_CONVEX_URL ?? ''}:${identity ? `${identity.profileId}:${identity.membershipId}` : 'anonymous'}`,
		userId: identity?.userId ?? null,
		membershipId: identity?.membershipId ?? null
	});
}
/** Only disposable, server-confirmed data belongs to this scope. Draft journals are separate. */
export function clearConfirmedCache(scope: CacheScope) {
	if (!scope.userId || !scope.membershipId) return;
	deletePersistentCache(`${scope.namespace}:snapshots`);
}
