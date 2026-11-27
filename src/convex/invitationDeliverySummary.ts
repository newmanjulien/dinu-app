import { readCompanySetup, patchCompanySetup } from './companySetupState';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';

export async function hasInvitedColleagues(ctx: QueryCtx, company: Doc<'company'>) {
	return (await readCompanySetup(ctx, company)).row?.colleaguesInvitedAt !== undefined;
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
		if (company && !(await hasInvitedColleagues(ctx, company)))
			await patchCompanySetup(ctx, company._id, { colleaguesInvitedAt: Date.now() });
	}
}
