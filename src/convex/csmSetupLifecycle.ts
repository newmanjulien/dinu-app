import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { pendingSuccessors, type PendingSuccessors } from './csmSetupChain';

type Appointment = Doc<'csmSetupAppointments'>;
export type SetupFiring = 'refresh' | 'deadline';

// Running work returns into row/generation fences. Never cancel a firing mutation.
export async function retirePendingSetupJobs(
	ctx: MutationCtx,
	a: Appointment,
	firing?: SetupFiring
) {
	for (const [kind, id] of [
		['refresh', a.refreshJobId],
		['deadline', a.deadlineJobId]
	] as const) {
		if (!id || kind === firing) continue;
		const job = await ctx.db.system.get('_scheduled_functions', id);
		if (job?.state.kind === 'pending') await ctx.scheduler.cancel(id);
	}
}

function hasMaintenance(a: Appointment) {
	return (
		a.refreshJobId !== undefined ||
		a.deadlineJobId !== undefined ||
		a.repairAt !== undefined ||
		a.leaseUntil !== undefined ||
		a.freshUntil !== undefined
	);
}
function pendingChanged(a: Appointment, pending: PendingSuccessors) {
	const previous = a.pendingSuccessors ?? { uids: [], overflow: false };
	return (
		previous.overflow !== pending.overflow ||
		previous.uids.length !== pending.uids.length ||
		previous.uids.some((uid, index) => uid !== pending.uids[index])
	);
}
/** Shared predicate for bounded stored-row normalization and aggregate verification. */
export function needsSupersededSetupRetirement(a: Appointment) {
	return !!(
		a.superseded &&
		(a.selection !== 'superseded' ||
			hasMaintenance(a) ||
			a.successorHint !== undefined ||
			pendingChanged(a, pendingSuccessors(a)))
	);
}

/** Permanent local retirement preserves identity and evidence; it does no provider work. */
export async function retireSupersededSetupAppointment(
	ctx: MutationCtx,
	a: Appointment,
	successorHint?: string,
	firing?: SetupFiring
) {
	const pending = pendingSuccessors(a, successorHint);
	const dirty = a.dirty || successorHint !== undefined || a.successorHint !== undefined;
	const invalidate = !a.superseded || hasMaintenance(a);
	if (
		!invalidate &&
		a.selection === 'superseded' &&
		a.successorHint === undefined &&
		!pendingChanged(a, pending) &&
		dirty === a.dirty
	)
		return false;
	await retirePendingSetupJobs(ctx, a, firing);
	await ctx.db.patch('csmSetupAppointments', a._id, {
		superseded: true,
		selection: 'superseded',
		generation: a.generation + (invalidate ? 1 : 0),
		refreshJobId: undefined,
		deadlineJobId: undefined,
		repairAt: undefined,
		leaseUntil: undefined,
		freshUntil: undefined,
		dirty,
		pendingSuccessors: pending,
		successorHint: undefined
	});
	return true;
}
