import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

export const defaultHelpPreferences = { contract: false, buyerLink: false };

export function preferenceForProfile(ctx: QueryCtx | MutationCtx, profileId: Id<'profiles'>) {
	return ctx.db
		.query('profileUiPreferences')
		.withIndex('by_profileId', (q) => q.eq('profileId', profileId))
		.unique();
}

export async function readHelpPreferences(ctx: QueryCtx, profile: Doc<'profiles'>) {
	const preference = await preferenceForProfile(ctx, profile._id);
	return preference?.helpPreferences ?? defaultHelpPreferences;
}

export async function deleteProfileUiPreferences(ctx: MutationCtx, profileId: Id<'profiles'>) {
	const preference = await preferenceForProfile(ctx, profileId);
	if (preference) await ctx.db.delete('profileUiPreferences', preference._id);
}
