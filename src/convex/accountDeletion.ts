import { cancelPreparationJobs } from './csmMeetingPreparation';
import { deleteMembershipUiPreferences } from './membershipUiPreferences';
import { deleteMembershipSetup } from './membershipSetupState';
import { deleteProfileUiPreferences } from './profileUiPreferences';
import { cancelJob } from './emailDeliveries';
import { cancelAppointmentJobs } from './csmSetupAppointments';
import { clearSetupAppointment } from './csmSetupState';
import { preserveErasedInitial } from './csmErasureGuards';
import { eraseProfileEvidence } from './csmEvidence';
import { eraseReplacementAttempt } from './csmReplacements';
import { paginationResultValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { internalMutation, internalQuery, query } from './_generated/server';
import { companyDeletion, liveProfile, membershipForProfile, requireProfile } from './auth';
import { CLEANUP_DISCOVERY_PAGE_SIZE, cleanupBudget } from './cleanup';
import { confirmAccountDeletion } from './companyDeletion';
import {
	ACCOUNT_DELETION_BATCH_SIZE,
	DELETING_RECOVERY_DELAY,
	MEMBERSHIP_ELIGIBILITY_SCAN_LIMIT,
	RECONCILIATION_PAGE_SIZE
} from './deletionPolicy';
import { deletionIdentity } from './deletionValidators';
import { activeJob } from './emailDeliveries';
import { deleteUnownedFile } from './storageOwnership';

async function scheduleCleanup(ctx: MutationCtx, marker: Doc<'deletedUsers'>) {
	const generation = marker.cleanupGeneration + 1;
	const jobId = await ctx.scheduler.runAfter(0, internal.accountDeletion.clean, {
		markerId: marker._id,
		generation
	});
	await ctx.db.patch('deletedUsers', marker._id, {
		cleanupJobId: jobId,
		cleanupGeneration: generation
	});
}

async function ensureCleanup(ctx: MutationCtx, marker: Doc<'deletedUsers'>) {
	if (marker.complete || (await activeJob(ctx, marker.cleanupJobId))) return;
	if (marker.recoveryCompanyId) {
		const receipt = await ctx.db
			.query('csmBookingAttempts')
			.withIndex('by_profileId', (q) => q.eq('profileId', marker.profileId))
			.first();
		const appointment = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_profileId', (q) => q.eq('profileId', marker.profileId))
			.first();
		if (!receipt && !appointment) return;
	}
	await scheduleCleanup(ctx, marker);
}

const deletionMode = v.union(
	v.literal('account'),
	v.literal('accountAndCompany'),
	v.literal('transferOwnership')
);
async function deletionOptions(ctx: QueryCtx) {
	const profile = await requireProfile(ctx);
	const membership = await membershipForProfile(ctx, profile._id);
	const company = membership ? await ctx.db.get('company', membership.companyId) : null;
	if (!membership || !company)
		throw new ConvexError('Your company access has changed. Reload to continue.');
	const owned = await ctx.db
		.query('company')
		.withIndex('by_ownerProfileId', (q) => q.eq('ownerProfileId', profile._id))
		.first();
	let mode: 'account' | 'accountAndCompany' | 'transferOwnership';
	if (owned && owned._id !== company._id) mode = 'transferOwnership';
	else {
		// The range read conflicts with a concurrent join or leave. Invitations are not members.
		const members = ctx.db
			.query('memberships')
			.withIndex('by_companyId', (q) => q.eq('companyId', company._id));
		let hasColleague = false;
		let scanned = 0;
		for await (const member of members) {
			if (++scanned > MEMBERSHIP_ELIGIBILITY_SCAN_LIMIT)
				throw new ConvexError(
					'Company membership cleanup is still in progress. Try again shortly.'
				);
			if (member.profileId !== profile._id && (await liveProfile(ctx, member.profileId))) {
				hasColleague = true;
				break;
			}
		}
		mode = hasColleague ? (owned ? 'transferOwnership' : 'account') : 'accountAndCompany';
	}
	const marker = await companyDeletion(ctx, company._id);
	const hold: 'none' | 'inProgress' | 'deleting' | 'cleaning' = !marker
		? 'none'
		: marker.status === 'deleting' &&
			  marker.issuer === profile.issuer &&
			  marker.clerkId === profile.clerkId
			? marker.inFlight
				? 'inProgress'
				: 'deleting'
			: 'cleaning';
	return {
		profile,
		mode,
		companyId: company._id,
		companyName: company.name,
		marker,
		hold
	};
}
export const options = query({
	args: {},
	returns: v.object({
		mode: deletionMode,
		companyId: v.id('company'),
		companyName: v.string(),
		hold: v.union(
			v.literal('none'),
			v.literal('inProgress'),
			v.literal('deleting'),
			v.literal('cleaning')
		)
	}),
	handler: async (ctx) => {
		const { profile: _profile, marker: _marker, ...options } = await deletionOptions(ctx);
		return options;
	}
});
const executionArgs = {
	mode: v.union(v.literal('account'), v.literal('accountAndCompany')),
	companyId: v.id('company'),
	confirmation: v.string(),
	executionId: v.string(),
	retryHold: v.optional(v.boolean())
};
const executionHold = v.object({
	id: v.id('companyDeletions'),
	executionId: v.string()
});
export const beginExecution = internalMutation({
	args: executionArgs,
	returns: v.object({
		issuer: v.string(),
		clerkId: v.string(),
		hold: v.union(executionHold, v.null())
	}),
	handler: async (ctx, args) => {
		const options = await deletionOptions(ctx);
		if (options.mode === 'transferOwnership')
			throw new ConvexError('Transfer company ownership before deleting your account.');
		if (args.mode !== options.mode || args.companyId !== options.companyId)
			throw new ConvexError(
				'Your company membership changed. Review the deletion confirmation again.'
			);
		const existing = options.marker;
		const ownsActiveHold =
			existing?.status === 'deleting' &&
			existing.issuer === options.profile.issuer &&
			existing.clerkId === options.profile.clerkId;
		if (args.retryHold) {
			if (!ownsActiveHold || options.mode !== 'accountAndCompany')
				throw new ConvexError('There is no pending deletion to retry.');
		} else {
			const phrase =
				options.mode === 'accountAndCompany'
					? 'delete my account and company'
					: 'delete my account';
			if (args.confirmation.trim() !== phrase)
				throw new ConvexError(`Type "${phrase}" to continue.`);
		}
		if (!args.executionId) throw new ConvexError('Invalid deletion request.');
		if (options.mode === 'accountAndCompany') {
			if (existing && !ownsActiveHold)
				throw new ConvexError('Company deletion is already in progress.');
			const requestedAt = Date.now();
			const id =
				existing?._id ??
				(await ctx.db.insert('companyDeletions', {
					companyId: options.companyId,
					issuer: options.profile.issuer,
					clerkId: options.profile.clerkId,
					executionId: args.executionId,
					requestedAt,
					status: 'deleting',
					inFlight: true,
					phase: 'invitations',
					cleanupGeneration: 0
				}));
			if (existing)
				await ctx.db.patch('companyDeletions', id, {
					executionId: args.executionId,
					requestedAt,
					inFlight: true
				});
			await ctx.db.patch('company', options.companyId, {
				deletion: {
					status: 'deleting',
					inFlight: true,
					issuer: options.profile.issuer,
					clerkId: options.profile.clerkId
				}
			});
			await ctx.scheduler.runAfter(DELETING_RECOVERY_DELAY, internal.clerk.resolveDeleting, {
				id,
				executionId: args.executionId
			});
			return {
				issuer: options.profile.issuer,
				clerkId: options.profile.clerkId,
				hold: { id, executionId: args.executionId }
			};
		}
		return {
			issuer: options.profile.issuer,
			clerkId: options.profile.clerkId,
			hold: null
		};
	}
});
export const markExecutionUncertain = internalMutation({
	args: { id: v.id('companyDeletions'), executionId: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const marker = await ctx.db.get('companyDeletions', args.id);
		if (marker?.status === 'deleting' && marker.executionId === args.executionId) {
			await ctx.db.patch('companyDeletions', marker._id, { inFlight: false });
			await ctx.db.patch('company', marker.companyId, {
				deletion: {
					status: 'deleting',
					inFlight: false,
					issuer: marker.issuer,
					clerkId: marker.clerkId
				}
			});
		}
		return null;
	}
});
export const abortExecution = internalMutation({
	args: { id: v.id('companyDeletions'), executionId: v.string() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const marker = await ctx.db.get('companyDeletions', args.id);
		if (!marker || marker.status !== 'deleting' || marker.executionId !== args.executionId)
			return false;
		await ctx.db.patch('company', marker.companyId, { deletion: undefined });
		await ctx.db.delete('companyDeletions', marker._id);
		return true;
	}
});
export const readOwnedHold = internalQuery({
	args: {},
	returns: v.union(
		v.null(),
		v.object({
			id: v.id('companyDeletions'),
			executionId: v.string(),
			requestedAt: v.number(),
			inFlight: v.boolean(),
			issuer: v.string(),
			clerkId: v.string(),
			status: v.union(v.literal('deleting'), v.literal('cleaning'), v.literal('complete'))
		})
	),
	handler: async (ctx) => {
		const profile = await requireProfile(ctx);
		const marker = await ctx.db
			.query('companyDeletions')
			.withIndex('by_issuer_and_clerkId', (q) =>
				q.eq('issuer', profile.issuer).eq('clerkId', profile.clerkId)
			)
			.unique();
		if (!marker) return null;
		return {
			id: marker._id,
			executionId: marker.executionId,
			requestedAt: marker.requestedAt,
			inFlight: marker.status === 'deleting' ? marker.inFlight : false,
			issuer: marker.issuer,
			clerkId: marker.clerkId,
			status: marker.status
		};
	}
});
async function markDeleted(ctx: MutationCtx, issuer: string, clerkId: string) {
	let marker = await ctx.db
		.query('deletedUsers')
		.withIndex('by_issuer_and_clerkId', (q) => q.eq('issuer', issuer).eq('clerkId', clerkId))
		.unique();
	if (!marker) {
		const profile = await ctx.db
			.query('profiles')
			.withIndex('by_issuer_and_clerkId', (q) => q.eq('issuer', issuer).eq('clerkId', clerkId))
			.unique();
		const deletedAt = Date.now();
		if (profile) await ctx.db.patch('profiles', profile._id, { deletedAt });
		const markerId = await ctx.db.insert('deletedUsers', {
			issuer,
			clerkId,
			deletedAt,
			cleanupGeneration: 0,
			successorCursor: null,
			...(profile ? { complete: false, profileId: profile._id } : { complete: true })
		});
		marker = await ctx.db.get('deletedUsers', markerId);
	}
	if (marker) await ensureCleanup(ctx, marker);
	await confirmAccountDeletion(ctx, issuer, clerkId);
	return null;
}
export const mark = internalMutation({
	args: deletionIdentity.fields,
	returns: v.null(),
	handler: (ctx, { issuer, clerkId }) => markDeleted(ctx, issuer, clerkId)
});
export const markMany = internalMutation({
	args: { identities: v.array(deletionIdentity) },
	returns: v.null(),
	handler: async (ctx, { identities }) => {
		if (identities.length > ACCOUNT_DELETION_BATCH_SIZE)
			throw new ConvexError('Account reconciliation batch is too large.');
		for (const identity of identities) {
			try {
				await ctx.runMutation(internal.accountDeletion.mark, identity);
			} catch (error) {
				console.error('Unable to record reconciled account deletion', identity.clerkId, error);
			}
		}
		return null;
	}
});
export const resume = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	returns: v.null(),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('deletedUsers')
			.withIndex('by_complete', (q) => q.eq('complete', false))
			.paginate({ cursor: cursor ?? null, numItems: CLEANUP_DISCOVERY_PAGE_SIZE });
		for (const marker of result.page) {
			try {
				await ctx.runMutation(internal.accountDeletion.resumeOne, { markerId: marker._id });
			} catch (error) {
				console.error('Unable to resume account deletion', marker._id, error);
			}
		}
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.accountDeletion.resume, {
				cursor: result.continueCursor
			});
		return null;
	}
});
export const resumeOne = internalMutation({
	args: { markerId: v.id('deletedUsers') },
	returns: v.null(),
	handler: async (ctx, { markerId }) => {
		const marker = await ctx.db.get('deletedUsers', markerId);
		if (marker) await ensureCleanup(ctx, marker);
		return null;
	}
});
export const clean = internalMutation({
	args: { markerId: v.id('deletedUsers'), generation: v.number() },
	returns: v.null(),
	handler: async (ctx, { markerId, generation }) => {
		const marker = await ctx.db.get('deletedUsers', markerId);
		// A retried or superseded cleanup job cannot continue an older chain.
		if (!marker || marker.complete || generation !== marker.cleanupGeneration) return null;
		const profileId = marker.profileId;
		const budget = cleanupBudget(ctx);
		if (!(await eraseProfileEvidence(ctx, profileId))) {
			await scheduleCleanup(ctx, marker);
			return null;
		}
		const preparations = await ctx.db
			.query('csmMeetingPreparations')
			.withIndex('by_profileId', (q) => q.eq('profileId', profileId))
			.take(25);
		for (const preparation of preparations) {
			await cancelPreparationJobs(ctx, preparation);
			await ctx.db.delete('csmMeetingPreparations', preparation._id);
		}
		if (preparations.length === 25) {
			await scheduleCleanup(ctx, marker);
			return null;
		}
		const appointments = await ctx.db
			.query('csmSetupAppointments')
			.withIndex('by_profileId', (q) => q.eq('profileId', profileId))
			.take(25);
		for (const appointment of appointments) {
			await cancelAppointmentJobs(ctx, appointment);
			await clearSetupAppointment(ctx, appointment);
			await ctx.db.delete('csmSetupAppointments', appointment._id);
		}
		if (appointments.length === 25) {
			await scheduleCleanup(ctx, marker);
			return null;
		}
		const attempts = await ctx.db
			.query('csmBookingAttempts')
			.withIndex('by_profileId', (q) => q.eq('profileId', profileId))
			.take(25);
		for (const attempt of attempts) {
			await preserveErasedInitial(ctx, attempt);
			await eraseReplacementAttempt(ctx, attempt);
			// Cancellation cannot stop a running action. Preserve its real outcome for guard observation.
			const sender = attempt.sendJobId
				? await ctx.db.system.get('_scheduled_functions', attempt.sendJobId)
				: null;
			if (sender?.state.kind === 'pending') await ctx.scheduler.cancel(sender._id);
			await cancelJob(ctx, attempt.watchdogJobId);
			await cancelJob(ctx, attempt.recoveryJobId);
			await ctx.db.delete('csmBookingAttempts', attempt._id);
		}
		if (attempts.length === 25) {
			await scheduleCleanup(ctx, marker);
			return null;
		}
		// Remove current identity-linked visits and their receipts before the profile.
		const activityBudget = budget;
		const activityDone = await activityBudget.drain(
			'buyerActivityOpenings',
			ctx.db
				.query('buyerActivityOpenings')
				.withIndex('by_profileId', (q) => q.eq('profileId', profileId)),
			{
				beforeDelete: (opening) =>
					activityBudget.drain(
						'buyerActivityReceipts',
						ctx.db
							.query('buyerActivityReceipts')
							.withIndex('by_openingId_and_itemId', (q) => q.eq('openingId', opening._id))
					)
			}
		);
		if (!activityDone) {
			await scheduleCleanup(ctx, marker);
			return null;
		}
		if (marker.recoveryCompanyId) {
			await ctx.db.patch('deletedUsers', marker._id, { cleanupJobId: undefined });
			return null;
		}
		const membership = await membershipForProfile(ctx, profileId);
		const owned = await ctx.db
			.query('company')
			.withIndex('by_ownerProfileId', (q) => q.eq('ownerProfileId', profileId))
			.first();
		if (owned && !(await companyDeletion(ctx, owned._id))) {
			const candidates = await ctx.db
				.query('memberships')
				.withIndex('by_companyId', (q) => q.eq('companyId', owned._id))
				.paginate({ cursor: marker.successorCursor, numItems: 25 });
			let successor;
			for (const candidate of candidates.page) {
				if (candidate.profileId !== profileId && (await liveProfile(ctx, candidate.profileId))) {
					successor = candidate;
					break;
				}
			}
			if (!successor && !candidates.isDone) {
				await ctx.db.patch('deletedUsers', marker._id, {
					successorCursor: candidates.continueCursor
				});
				await scheduleCleanup(ctx, marker);
				return null;
			}
			if (!successor) {
				// Do not convert a company into an inaccessible, ownerless record. The
				// deleted account is retained only until an operator assigns a live owner.
				await ctx.db.patch('deletedUsers', marker._id, {
					recoveryCompanyId: owned._id,
					cleanupJobId: undefined
				});
				return null;
			}
			await ctx.db.patch('company', owned._id, { ownerProfileId: successor?.profileId });
		}
		if (membership) {
			await deleteMembershipUiPreferences(ctx, membership._id);
			await deleteMembershipSetup(ctx, membership._id);
			await ctx.db.delete('memberships', membership._id);
		}
		const profile = await ctx.db.get('profiles', profileId);
		if (profile) {
			await deleteProfileUiPreferences(ctx, profile._id);
			await ctx.db.delete('profiles', profile._id);
		}
		if (profile?.avatarId) await deleteUnownedFile(ctx, profile.avatarId);
		await ctx.db.patch('deletedUsers', markerId, { complete: true, cleanupJobId: undefined });
		return null;
	}
});
export const registered = internalQuery({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: paginationResultValidator(deletionIdentity),
	handler: async (ctx, { cursor }) => {
		const result = await ctx.db
			.query('profiles')
			.withIndex('by_creation_time')
			.paginate({
				cursor,
				numItems: RECONCILIATION_PAGE_SIZE,
				maximumRowsRead: RECONCILIATION_PAGE_SIZE,
				maximumBytesRead: 2 * 1024 * 1024
			});
		return {
			...result,
			page: result.page.map(({ issuer, clerkId }) => ({ issuer, clerkId }))
		};
	}
});
