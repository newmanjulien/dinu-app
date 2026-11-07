import type { PlaybookItem } from '../../src/lib/playbook/model';
import type { MutationCtx } from '../../src/convex/_generated/server';
import type { BaselineBlock } from '../../src/lib/contract/source-model';

export const block: BaselineBlock = {
	kind: 'paragraph',
	role: 'body',
	blockKey: 'paragraph-1',
	order: 0,
	content: [{ kind: 'text', sourceKey: 'text-1', text: 'Synthetic contract.' }]
};

export const item: PlaybookItem = {
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

export const choicesFor = (selections: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(selections).map(([id, concessionId]) => [id, { concessionId }])
	);

/** Stable ordered inputs for the canonical save protocol in existing fixtures. */
export function commandsFor(
	base: import('../../src/lib/contract/applications').ApplicationChoices,
	choices: import('../../src/lib/contract/applications').ApplicationChoices,
	operation: string
): import('../../src/lib/contract/activity-commands').ActivityCommand[] {
	return [...new Set([...Object.keys(base), ...Object.keys(choices)])]
		.filter(
			(id) =>
				JSON.stringify(
					base[id as import('../../src/convex/_generated/dataModel').Id<'playbookItems'>]
				) !==
				JSON.stringify(
					choices[id as import('../../src/convex/_generated/dataModel').Id<'playbookItems'>]
				)
		)
		.map((id, index) => ({
			id: `${operation}:${index}`,
			itemId: id as import('../../src/convex/_generated/dataModel').Id<'playbookItems'>,
			choice:
				choices[id as import('../../src/convex/_generated/dataModel').Id<'playbookItems'>] ?? null,
			occurredAt: 123
		}));
}
