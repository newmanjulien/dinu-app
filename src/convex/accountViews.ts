import { v } from 'convex/values';
import { setupCallView } from './csmSetupValidators';
import { permissions, role } from './permissions';

export const helpPreferences = v.object({ rep: v.boolean(), buyer: v.boolean() });

export const profileView = v.object({
	id: v.id('profiles'),
	name: v.string(),
	email: v.string(),
	avatarUrl: v.union(v.string(), v.null())
});
export const accountView = v.object({
	profile: profileView,
	helpPreferences,
	permissions,
	membership: v.union(
		v.null(),
		v.object({
			id: v.id('memberships'),
			role,
			companyId: v.id('company'),
			isOwner: v.boolean()
		})
	),
	company: v.union(
		v.null(),
		v.object({
			id: v.id('company'),
			name: v.string(),
			avatarUrl: v.union(v.string(), v.null()),
			approvalEmail: v.union(v.string(), v.null()),
			setupCall: setupCallView,
			deletionPending: v.boolean()
		})
	),
	needsInitialization: v.boolean(),
	templateReady: v.boolean(),
	instructionsReady: v.boolean()
});
export const viewerResult = v.union(v.null(), accountView);

/** A colleague combines person details with this company's membership role. */
export const memberView = profileView.extend({
	role,
	membershipId: v.id('memberships'),
	isOwner: v.boolean()
});
