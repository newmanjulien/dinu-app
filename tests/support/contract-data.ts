import { fixtureOperationId } from './operation';
import type { RepInstruction } from '../../src/lib/playbook/model';
import type { MutationCtx } from '../../src/convex/_generated/server';
import type { SourceBlock } from '../../src/lib/document/source-model';

export const block: SourceBlock = {
	kind: 'paragraph',
	role: 'body',
	blockKey: 'paragraph-1',
	order: 0,
	content: [{ kind: 'text', sourceKey: 'text-1', text: 'Synthetic contract.' }]
};

export const item: RepInstruction = {
	audience: 'rep',
	approvalPolicy: { kind: 'none' },
	trigger: {
		id: 'trigger',
		target: {
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
		helpPreferences: { rep: false, buyer: false },
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

/** Ordered native commands compare server-returned current heads. */
export function commandsFor(
	base: readonly import('../../src/lib/contract/changes').PlaybookState[],
	choices: Record<string, string>,
	operation: string
): import('../../src/lib/contract/activity-commands').ActivityCommand[] {
	return [...new Set([...base.map((item) => item.itemId), ...Object.keys(choices)])]
		.filter(
			(id) =>
				(base.find((item) => item.itemId === id)?.currentOptionId ?? null) !== (choices[id] ?? null)
		)
		.map((id, index) => ({
			id: fixtureOperationId(`${operation}:${index}`),
			itemId: id as import('../../src/convex/_generated/dataModel').Id<'playbookItems'>,
			expectedCurrentChangeId: base.find((item) => item.itemId === id)?.currentChangeId ?? null,
			action: { kind: 'set', optionId: choices[id] ?? null },
			occurredAt: 123
		}));
}
