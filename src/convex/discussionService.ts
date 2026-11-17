import { buyerName } from './contractBuyer';
import { ConvexError, type Infer } from 'convex/values';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { DiscussionContext } from './discussionContext';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { liveProfile, memberForCompany, requireMembership, type CompanyAccess } from './auth';
import { sellerAuthorName } from './authorPresentation';
import type { publicAuthor } from '../lib/discussions/validators';
import { sellerPreparationActor, type PreparationActor } from './discussionPreparation';

export const fingerprint = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)));
export type DiscussionActor = {
	key: string;
	profileId?: Doc<'profiles'>['_id'];
	access?: CompanyAccess;
	preparation: PreparationActor;
};
export async function discussionActor(
	ctx: QueryCtx,
	context: DiscussionContext,
	browserId?: string
): Promise<DiscussionActor> {
	const { root, link } = context;
	const member = await memberForCompany(ctx, root.companyId);
	if (member) {
		const access = await requireMembership(ctx, member.membership._id);
		return {
			key: fingerprint(JSON.stringify([root._id, 'account', member.profile._id])),
			profileId: member.profile._id,
			access,
			preparation: { ...sellerPreparationActor(access), link: { id: link._id, token: link.token } }
		};
	}
	if (!browserId || !/^[a-f0-9-]{36}$/u.test(browserId))
		throw new ConvexError('Reopen the discussion and try again.');
	const accountIdentity = (await ctx.auth.getUserIdentity())?.tokenIdentifier;
	const key = fingerprint(JSON.stringify([root._id, 'buyer', browserId, accountIdentity ?? null]));
	return {
		key,
		preparation: {
			kind: 'buyer',
			browserId,
			actorKey: key,
			linkId: link._id,
			token: link.token,
			...(accountIdentity ? { accountIdentity } : {})
		}
	};
}
export async function authorView(
	ctx: QueryCtx,
	contract: Doc<'savedContracts'>,
	actor: Pick<DiscussionActor, 'profileId' | 'key'>
): Promise<Infer<typeof publicAuthor>> {
	const profile = actor.profileId ? await liveProfile(ctx, actor.profileId) : null;
	return {
		key: actor.key,
		name: actor.profileId
			? await sellerAuthorName(ctx, contract.companyId, profile)
			: buyerName(contract) || 'Buyer',
		avatarUrl: profile?.avatarId ? await ctx.storage.getUrl(profile.avatarId) : null,
		buyer: !actor.profileId
	};
}
export function messageProjector(ctx: QueryCtx, contract: Doc<'savedContracts'>) {
	const authors = new Map<string, Promise<Infer<typeof publicAuthor>>>();
	return async (message: Doc<'discussionMessages'>) => {
		if (message.contractId !== contract._id || message.companyId !== contract.companyId)
			throw new Error('Discussion ownership is invalid.');
		const cacheKey = JSON.stringify([contract._id, message.profileId ?? null]);
		let author = authors.get(cacheKey);
		if (!author) {
			author = authorView(ctx, contract, { key: '', profileId: message.profileId });
			authors.set(cacheKey, author);
		}
		return {
			id: message._id,
			text: message.deleted ? '' : message.text,
			revision: message.revision,
			deleted: message.deleted,
			createdAt: message._creationTime,
			operationId: message.operationId ?? null,
			author: { ...(await author), key: message.authorKey }
		};
	};
}
/** Anchors and proposal normalization share the same current-approved composition. */
export { resolvedDiscussionDocument as resolvedDiscussion } from '../lib/discussions/tape';
