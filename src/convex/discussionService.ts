import { ConvexError, type Infer } from 'convex/values';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Doc } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import type { publicAuthor } from '../lib/discussions/validators';
import { liveProfile, memberForCompany, type CompanyAccess } from './auth';
import { sellerAuthorName } from './authorPresentation';
import { buyerName } from './contractBuyer';

export const fingerprint = (value: string) => bytesToHex(sha256(new TextEncoder().encode(value)));

export type DiscussionActor = {
	key: string;
	profileId?: Doc<'profiles'>['_id'];
	access?: CompanyAccess;
};

export function sellerDiscussionActor(
	root: Doc<'savedContracts'>,
	access: CompanyAccess
): DiscussionActor {
	if (access.companyId !== root.companyId)
		throw new Error('Discussion access does not belong to this contract company.');
	return {
		key: fingerprint(JSON.stringify([root._id, 'account', access.profile._id])),
		profileId: access.profile._id,
		access
	};
}

export async function buyerDiscussionActor(
	ctx: QueryCtx,
	root: Doc<'savedContracts'>,
	browserId: string
): Promise<DiscussionActor> {
	if (await memberForCompany(ctx, root.companyId))
		throw new ConvexError('Comment on this contract from your dashboard.');
	if (!browserId || !/^[a-f0-9-]{36}$/u.test(browserId))
		throw new ConvexError('Reopen the discussion and try again.');
	const accountIdentity = (await ctx.auth.getUserIdentity())?.tokenIdentifier;
	const key = fingerprint(JSON.stringify([root._id, 'buyer', browserId, accountIdentity ?? null]));
	return { key };
}

export async function authorView(
	ctx: QueryCtx,
	contract: Doc<'savedContracts'>,
	actor: Pick<DiscussionActor, 'profileId' | 'key' | 'access'>
): Promise<Infer<typeof publicAuthor>> {
	const profile =
		actor.access && actor.access.profile._id === actor.profileId
			? actor.access.profile
			: actor.profileId
				? await liveProfile(ctx, actor.profileId)
				: null;
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
	const author = async (actor: DiscussionActor) => {
		const cacheKey = actor.profileId ?? 'buyer';
		let presentation = authors.get(cacheKey);
		if (!presentation) {
			presentation = authorView(ctx, contract, actor);
			authors.set(cacheKey, presentation);
		}
		return { ...(await presentation), key: actor.key };
	};
	return {
		author,
		message: async (message: Doc<'discussionMessages'>) => {
			if (message.contractId !== contract._id || message.companyId !== contract.companyId)
				throw new Error('Discussion ownership is invalid.');
			return {
				id: message._id,
				text: message.text,
				revision: message.revision,
				createdAt: message._creationTime,
				operationId: message.operationId ?? null,
				author: await author({ key: message.authorKey, profileId: message.profileId })
			};
		}
	};
}
