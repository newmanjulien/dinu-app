import type { BaselineBlock } from '../../src/lib/contract/source-model';
import type { MutationCtx } from '../../src/convex/_generated/server';
import type { Doc } from '../../src/convex/_generated/dataModel';

export const block: BaselineBlock = {
	kind: 'paragraph',
	blockKey: 'paragraph-1',
	order: 0,
	content: [{ kind: 'text', sourceKey: 'text-1', text: 'Synthetic contract.' }]
};

export const item: Omit<
	Doc<'playbookItems'>,
	'_id' | '_creationTime' | 'companyId' | 'revision' | 'publishedRevisionId'
> = {
	trigger: {
		id: 'trigger',
		range: {
			kind: 'text',
			range: { start: { sourceKey: 'text-1', offset: 0 }, end: { sourceKey: 'text-1', offset: 9 } }
		}
	},
	concessions: [
		{ id: 'preferred', tier: 'preferred', description: 'Synthetic choice.', changes: [] }
	]
};

export const identity = {
	issuer: 'https://perf.clerk.accounts.dev',
	subject: 'user_rep',
	tokenIdentifier: 'https://perf.clerk.accounts.dev|user_rep',
	email: 'rep@example.com',
	emailVerified: true
};
export async function initializeViewer(ctx: MutationCtx) {
	const id = await ctx.db.insert('profiles', {
		identity: identity.tokenIdentifier,
		issuer: identity.issuer,
		clerkId: identity.subject,
		email: identity.email,
		name: 'Rep'
	});
	const companyId = await ctx.db.insert('company', {
		name: 'Synthetic company',
		ownerProfileId: id,
		approvalEmail: 'approver@example.com'
	});
	const membershipId = await ctx.db.insert('memberships', {
		companyId,
		profileId: id,
		role: 'admin'
	});
	return { profileId: id, companyId, membershipId };
}
