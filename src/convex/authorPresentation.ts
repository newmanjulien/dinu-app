import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';

/** Seller author labels use their profile, then the contract's company. */
export async function sellerAuthorName(
	ctx: QueryCtx,
	companyId: Id<'company'>,
	profile: Pick<Doc<'profiles'>, 'name' | 'email'> | null
): Promise<string> {
	const name = profile?.name.trim();
	if (name) return name;
	const email = profile?.email.trim();
	if (email) return email;
	const company = await ctx.db.get('company', companyId);
	if (!company?.name.trim()) throw new Error('The seller company is unavailable.');
	return company.name.trim();
}
