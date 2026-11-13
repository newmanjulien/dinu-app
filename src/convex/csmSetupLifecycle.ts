import type { Doc, Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import type { MutationCtx } from './_generated/server';
import { historicalSuccessorHint } from './csmHistory';
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
		a.freshUntil !== undefined ||
		a.reviewSession !== undefined
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
			historicalSuccessorHint(a) !== undefined ||
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
	const dirty = a.dirty || successorHint !== undefined || historicalSuccessorHint(a) !== undefined;
	const invalidate = !a.superseded || hasMaintenance(a);
	if (
		!invalidate &&
		a.selection === 'superseded' &&
		historicalSuccessorHint(a) === undefined &&
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
		reviewSession: undefined,
		dirty,
		pendingSuccessors: pending,
		successorHint: undefined
	});
	return true;
}

/** Shared template release hook. Continuations bound history work independently of release size. */
export async function retireCompanySetupAppointments(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	cursor: string | null = null
) {
	const company = await ctx.db.get('company', companyId);
	if (!company?.templateSourceId) return;
	const page = await ctx.db
		.query('csmSetupAppointments')
		.withIndex('by_companyId_and_selection_and_sortAt_and_anchorUid', (q) =>
			q.eq('companyId', companyId)
		)
		.paginate({ cursor, numItems: 25 });
	for (const a of page.page) await retireReleasedSetupAppointment(ctx, a);
	if (!page.isDone)
		await ctx.scheduler.runAfter(0, internal.csmSetupAppointments.retireReleased, {
			companyId,
			cursor: page.continueCursor
		});
}

/** Release ends maintenance, while confirmed facts and unresolved evidence remain historical. */
export async function retireReleasedSetupAppointment(
	ctx: MutationCtx,
	a: Appointment,
	firing?: SetupFiring
) {
	if (a.superseded) return retireSupersededSetupAppointment(ctx, a, undefined, firing);
	if (a.maintenanceRetired === 'released' && !hasMaintenance(a) && !a.reviewSession) return false;
	await retirePendingSetupJobs(ctx, a, firing);
	await ctx.db.patch('csmSetupAppointments', a._id, {
		maintenanceRetired: 'released',
		generation: a.generation + 1,
		refreshJobId: undefined,
		deadlineJobId: undefined,
		repairAt: undefined,
		leaseUntil: undefined,
		freshUntil: undefined,
		reviewSession: undefined
	});
	return true;
}
