import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

export async function hasInvitedColleagues(ctx: QueryCtx, company: Doc<'company'>) {
	if (company.colleaguesInvitedAt !== undefined) return true;
	// Recognize invitations sent or accepted before the company milestone was introduced.
	const [sent, accepted] = await Promise.all([
		ctx.db
			.query('companyInvitations')
			.withIndex('by_companyId_and_deliveryStatus', (q) =>
				q.eq('companyId', company._id).eq('deliveryStatus', 'sent')
			)
			.first(),
		ctx.db
			.query('companyInvitations')
			.withIndex('by_companyId_and_status', (q) =>
				q.eq('companyId', company._id).eq('status', 'accepted')
			)
			.first()
	]);
	return Boolean(sent || accepted);
}

/** Invitation list projection. The delivery remains authoritative for the full outcome. */
export function pendingInvitationDelivery(generation: number, startedAt: number) {
	return {
		deliveryStatus: 'sending' as const,
		deliveryGeneration: generation,
		deliveryStartedAt: startedAt
	};
}

export async function completeInvitationDelivery(
	ctx: MutationCtx,
	delivery: Doc<'emailDeliveries'>,
	outcome: 'sent' | 'failed' | 'uncertain' | 'skipped'
) {
	if (delivery.event.kind !== 'invitation') return;
	const invitation = await ctx.db.get('companyInvitations', delivery.event.invitationId);
	if (
		invitation?.deliveryId !== delivery._id ||
		invitation.deliveryGeneration !== delivery.event.generation
	)
		return;
	await ctx.db.patch('companyInvitations', invitation._id, {
		deliveryStatus: outcome === 'sent' ? 'sent' : 'failed'
	});
	if (outcome === 'sent') {
		const company = await ctx.db.get('company', invitation.companyId);
		if (company && company.colleaguesInvitedAt === undefined)
			await ctx.db.patch('company', company._id, { colleaguesInvitedAt: Date.now() });
	}
}
