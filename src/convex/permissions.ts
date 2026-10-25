import { ConvexError, v, type Infer } from 'convex/values';
export const role = v.union(v.literal('rep'), v.literal('admin'));
export type Role = Infer<typeof role>;
export const permissions = v.object({
	editCompanyProfile: v.boolean(),
	manageMembers: v.boolean(),
	manageTemplate: v.boolean(),
	manageOwnership: v.boolean()
});
export type Permissions = Infer<typeof permissions>;
export type Permission = keyof Permissions;
export function permissionsForRole(role: Role, isOwner = false): Permissions {
	return {
		editCompanyProfile: role === 'admin',
		manageMembers: role === 'admin',
		manageTemplate: role === 'admin',
		manageOwnership: isOwner
	};
}
export function assertPermission(role: Role, permission: Permission, isOwner = false) {
	if (!permissionsForRole(role, isOwner)[permission])
		throw new ConvexError('You do not have permission to perform this action.');
}
