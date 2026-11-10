import { browser } from '$app/environment';
import { env } from '$env/dynamic/public';
import type { Id } from '../../convex/_generated/dataModel';
import type { Role } from '../../convex/permissions';

export type WorkspaceMembership = {
	membershipId: Id<'memberships'>;
	companyId: Id<'company'>;
	role: Role;
};

function key(userId: string) {
	return `dinu:v1:${env.PUBLIC_CONVEX_URL ?? ''}:workspace-role:${userId}`;
}

export function readWorkspaceRole(userId: string): WorkspaceMembership | undefined {
	if (!browser) return;
	try {
		const value: unknown = JSON.parse(localStorage.getItem(key(userId)) ?? 'null');
		if (
			value &&
			typeof value === 'object' &&
			'membershipId' in value &&
			typeof value.membershipId === 'string' &&
			value.membershipId &&
			'companyId' in value &&
			typeof value.companyId === 'string' &&
			value.companyId &&
			'role' in value &&
			(value.role === 'admin' || value.role === 'rep')
		)
			return value as WorkspaceMembership;
	} catch {
		/* Storage is optional; account startup can fetch the role instead. */
	}
}

export function rememberWorkspaceRole(userId: string, membership: WorkspaceMembership | null) {
	if (!browser) return;
	try {
		if (!membership) localStorage.removeItem(key(userId));
		else {
			const value = JSON.stringify(membership);
			if (localStorage.getItem(key(userId)) !== value) localStorage.setItem(key(userId), value);
		}
	} catch {
		/* Keep the in-memory result when persistent storage is unavailable. */
	}
}
