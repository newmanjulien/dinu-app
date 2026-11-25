'use node';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { ConvexError, v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { action, env } from './_generated/server';
import { verifiedIdentity } from './auth';
import { DELETING_RECOVERY_DELAY, REVERIFICATION_MAX_AGE_MINUTES } from './deletionPolicy';

function clerkClient() {
	if (!env.CLERK_SECRET_KEY || !env.CLERK_JWT_ISSUER_DOMAIN)
		throw new ConvexError('Account deletion is unavailable right now. Please try again later.');
	return createClerkClient({
		secretKey: env.CLERK_SECRET_KEY,
		telemetry: { disabled: true }
	});
}

function isValidFactorAge(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && (value === -1 || value >= 0);
}

/** Matches Clerk's strict reverification rule (`second_factor`, 10 minutes). */
function hasFreshReverification(fva: unknown) {
	if (!Array.isArray(fva) || fva.length !== 2) return false;
	const [factor1Age, factor2Age] = fva;
	if (!isValidFactorAge(factor1Age) || !isValidFactorAge(factor2Age)) return false;
	if (factor1Age === -1 && factor2Age === -1) return false;
	const factor1Fresh = factor1Age !== -1 && factor1Age < REVERIFICATION_MAX_AGE_MINUTES;
	const factor2Fresh = factor2Age !== -1 && factor2Age < REVERIFICATION_MAX_AGE_MINUTES;
	return factor2Age === -1 ? factor1Fresh : factor2Fresh;
}

function clerkStatus(error: unknown): number | null {
	if (typeof error === 'object' && error !== null && 'status' in error) {
		const status = (error as { status: unknown }).status;
		if (typeof status === 'number') return status;
	}
	return null;
}

export const execute = action({
	args: {
		mode: v.union(v.literal('account'), v.literal('accountAndCompany')),
		companyId: v.id('company'),
		confirmation: v.string(),
		sessionToken: v.string(),
		retryHold: v.optional(v.boolean())
	},
	returns: v.union(
		v.object({ status: v.literal('deleted') }),
		v.object({ status: v.literal('reverificationRequired') })
	),
	handler: async (
		ctx,
		args
	): Promise<{ status: 'deleted' } | { status: 'reverificationRequired' }> => {
		const identity = await verifiedIdentity(ctx);
		const clerk = clerkClient();
		if (identity.issuer !== env.CLERK_JWT_ISSUER_DOMAIN)
			throw new ConvexError('Unable to verify your session. Please try again.');
		let payload: Awaited<ReturnType<typeof verifyToken>>;
		try {
			payload = await verifyToken(args.sessionToken, { secretKey: env.CLERK_SECRET_KEY! });
		} catch {
			return { status: 'reverificationRequired' };
		}
		if (payload.sub !== identity.subject || payload.iss !== identity.issuer)
			throw new ConvexError('Your session changed. Please try again.');
		if (payload.act)
			throw new ConvexError('Account deletion is unavailable while impersonating a user.');
		if (!hasFreshReverification(payload.fva)) return { status: 'reverificationRequired' };

		const executionId = crypto.randomUUID();
		const began: {
			issuer: string;
			clerkId: string;
			hold: { id: Id<'companyDeletions'>; executionId: string } | null;
		} = await ctx.runMutation(internal.accountDeletion.beginExecution, {
			mode: args.mode,
			companyId: args.companyId,
			confirmation: args.confirmation,
			executionId,
			retryHold: args.retryHold
		});

		try {
			await clerk.users.deleteUser(began.clerkId);
		} catch (error) {
			const status = clerkStatus(error);
			if (status !== 404) {
				// Definitive non-delete 4xx refusal: release any hold immediately.
				if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) {
					if (began.hold) {
						try {
							await ctx.runMutation(internal.accountDeletion.abortExecution, began.hold);
						} catch (abortError) {
							console.error('Unable to release company deletion hold after refusal', abortError);
						}
					}
					throw new ConvexError('Unable to delete your account right now. Please try again.');
				}
				// Ambiguous failure (408/429/5xx/network): mark uncertain so user can safely retry/cancel.
				if (began.hold) {
					try {
						await ctx.runMutation(internal.accountDeletion.markExecutionUncertain, began.hold);
					} catch (markError) {
						console.error('Unable to mark company deletion hold uncertain', markError);
					}
				}
				throw new ConvexError(
					began.hold
						? 'Account deletion could not be confirmed right now. You can retry or cancel it in Settings.'
						: 'Unable to delete your account right now. Please try again.'
				);
			}
		}

		await ctx.runMutation(internal.accountDeletion.mark, {
			issuer: began.issuer,
			clerkId: began.clerkId
		});
		return { status: 'deleted' };
	}
});

export const cancelHold = action({
	args: {},
	returns: v.union(v.literal('cancelled'), v.literal('deleted'), v.literal('none')),
	handler: async (ctx): Promise<'cancelled' | 'deleted' | 'none'> => {
		const identity = await verifiedIdentity(ctx);
		const clerk = clerkClient();
		const hold: {
			id: Id<'companyDeletions'>;
			executionId: string;
			requestedAt: number;
			inFlight: boolean;
			issuer: string;
			clerkId: string;
			status: 'deleting' | 'cleaning' | 'complete';
		} | null = await ctx.runQuery(internal.accountDeletion.readOwnedHold, {});
		if (!hold || hold.status !== 'deleting') return 'none';
		if (hold.issuer !== env.CLERK_JWT_ISSUER_DOMAIN || hold.issuer !== identity.issuer)
			throw new ConvexError('Unable to verify your session. Please try again.');
		if (hold.inFlight && hold.requestedAt + DELETING_RECOVERY_DELAY > Date.now())
			throw new ConvexError('Deletion is still in progress. Please wait a moment and try again.');

		try {
			await clerk.users.getUser(hold.clerkId);
		} catch (error) {
			if (clerkStatus(error) === 404) {
				await ctx.runMutation(internal.accountDeletion.mark, {
					issuer: hold.issuer,
					clerkId: hold.clerkId
				});
				return 'deleted';
			}
			throw new ConvexError('Unable to verify your account status right now. Please try again.');
		}

		const released: boolean = await ctx.runMutation(internal.accountDeletion.abortExecution, {
			id: hold.id,
			executionId: hold.executionId
		});
		return released ? 'cancelled' : 'none';
	}
});
