import {
	emailAddress,
	invitationPreviewData,
	invitationResolutionData,
	type InvitationPreviewData,
	type InvitationResolutionData
} from './invitationValidators';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { ConvexError, v } from 'convex/values';
import { query, mutation, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import {
	requireProfile,
	requirePermission,
	verifiedIdentity,
	availableCompany,
	requireCompany
} from './auth';
const invitationView = v.object({
	id: v.id('companyInvitations'),
	email: v.string(),
	createdAt: v.number(),
	expiresAt: v.number(),
	deliveryStatus: v.union(v.literal('sending'), v.literal('sent'), v.literal('failed'))
});
export const list = query({
	args: {
		membershipId: v.id('memberships'),
		paginationOpts: paginationOptsValidator
	},
	returns: paginationResultValidator(invitationView),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'manageMembers', args.membershipId);
		const result = await ctx.db
			.query('companyInvitations')
			.withIndex('by_companyId_and_status', (q) =>
				q.eq('companyId', access.companyId).eq('status', 'pending')
			)
			.order('desc')
			.paginate(args.paginationOpts);
		return {
			...result,
			page: result.page.map((i) => ({
				id: i._id,
				email: i.normalizedEmail,
				createdAt: i._creationTime,
				expiresAt: i.expiresAt,
				deliveryStatus: i.deliveryStatus
			}))
		};
	}
});
export const inbox = query({
	args: {},
	returns: v.array(
		v.object({
			id: v.id('companyInvitations'),
			companyName: v.string(),
			inviterName: v.string()
		})
	),
	handler: async (ctx) => {
		await requireProfile(ctx);
		const identity = await verifiedIdentity(ctx);
		const invitations = await ctx.db
			.query('companyInvitations')
			.withIndex('by_normalizedEmail_and_status_and_expired_and_expiresAt', (q) =>
				q
					.eq('normalizedEmail', emailAddress(identity.email!))
					.eq('status', 'pending')
					.eq('expired', false)
			)
			.order('desc')
			.take(100);
		const result = await Promise.all(
			invitations.map(async (i) => {
				const [company, inviter] = await Promise.all([
					availableCompany(ctx, i.companyId),
					ctx.db.get('profiles', i.inviterProfileId)
				]);
				return company
					? {
							id: i._id,
							companyName: company.name,
							inviterName: inviter?.name || 'A colleague'
						}
					: null;
			})
		);
		return result.filter((invitation) => invitation !== null);
	}
});
export const accept = mutation({
	args: { invitationId: v.id('companyInvitations'), deliveryGeneration: v.optional(v.number()) },
	returns: v.id('memberships'),
	handler: async (ctx, args) => {
		const profile = await requireProfile(ctx);
		const identity = await verifiedIdentity(ctx);
		const invitation = await ctx.db.get('companyInvitations', args.invitationId);
		if (!invitation || invitation.normalizedEmail !== emailAddress(identity.email!))
			throw new ConvexError('Sign in with the email address this invitation was sent to.');
		if (
			args.deliveryGeneration !== undefined &&
			args.deliveryGeneration !== invitation.deliveryGeneration
		)
			throw new ConvexError('This invitation was replaced. Open the latest invitation email.');
		const membership = await ctx.db
			.query('memberships')
			.withIndex('by_profileId', (q) => q.eq('profileId', profile._id))
			.unique();
		await requireCompany(ctx, invitation.companyId);
		if (
			invitation.status === 'accepted' &&
			invitation.acceptedByProfileId === profile._id &&
			membership?.companyId === invitation.companyId
		)
			return membership._id;
		if (invitation.status !== 'pending' || invitation.expiresAt <= Date.now())
			throw new ConvexError(
				'This invitation has expired or was revoked. Ask a colleague for a new invitation.'
			);
		if (membership)
			throw new ConvexError('Leave your current company before accepting this invitation.');
		const id = await ctx.db.insert('memberships', {
			companyId: invitation.companyId,
			profileId: profile._id
		});
		await ctx.db.patch('companyInvitations', invitation._id, {
			status: 'accepted',
			acceptedByProfileId: profile._id,
			acceptedAt: Date.now()
		});
		return id;
	}
});
export const revoke = mutation({
	args: { membershipId: v.id('memberships'), invitationId: v.id('companyInvitations') },
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'manageMembers', args.membershipId);
		const invitation = await ctx.db.get('companyInvitations', args.invitationId);
		if (!invitation || invitation.companyId !== access.companyId)
			throw new ConvexError('This invitation is unavailable.');
		if (invitation.status === 'pending')
			await ctx.db.patch('companyInvitations', invitation._id, {
				status: 'revoked',
				deliveryGeneration: invitation.deliveryGeneration + 1
			});
		return null;
	}
});
export const prepareDelivery = internalMutation({
	args: {
		membershipId: v.id('memberships'),
		email: v.string(),
		tokenHash: v.string(),
		resend: v.boolean()
	},
	returns: v.union(
		v.null(),
		v.object({
			id: v.id('companyInvitations'),
			generation: v.number(),
			email: v.string(),
			companyName: v.string(),
			inviterName: v.string()
		})
	),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'manageMembers', args.membershipId);
		const email = emailAddress(args.email);
		const profiles = await ctx.db
			.query('profiles')
			.withIndex('by_email', (q) => q.eq('email', email))
			.take(101);
		if (profiles.length > 100) throw new ConvexError('Unable to verify this email address.');
		for (const profile of profiles) {
			const member = await ctx.db
				.query('memberships')
				.withIndex('by_profileId', (q) => q.eq('profileId', profile._id))
				.unique();
			if (member?.companyId === access.companyId)
				throw new ConvexError('This colleague already belongs to your company.');
		}
		const existing = await ctx.db
			.query('companyInvitations')
			.withIndex('by_companyId_and_normalizedEmail_and_status', (q) =>
				q.eq('companyId', access.companyId).eq('normalizedEmail', email).eq('status', 'pending')
			)
			.unique();
		if (existing && (existing.deliveryStartedAt ?? 0) > Date.now() - 120_000)
			throw new ConvexError('An invitation is already being sent. Please wait.');
		if (
			existing &&
			!args.resend &&
			existing.deliveryStatus === 'sent' &&
			existing.expiresAt > Date.now()
		)
			return null;
		const generation = (existing?.deliveryGeneration ?? 0) + 1;
		const data = {
			inviterProfileId: access._id,
			tokenHash: args.tokenHash,
			expiresAt: Date.now() + 7 * 86400_000,
			expired: false,
			deliveryStatus: 'sending' as const,
			deliveryGeneration: generation,
			deliveryStartedAt: Date.now()
		};
		let id;
		if (existing) {
			id = existing._id;
			await ctx.db.patch('companyInvitations', id, data);
		} else
			id = await ctx.db.insert('companyInvitations', {
				...data,
				companyId: access.companyId,
				normalizedEmail: email,
				status: 'pending'
			});
		// Commit the timeout with preparation so an interrupted action cannot strand delivery.
		await ctx.scheduler.runAfter(120_000, internal.companyInvitations.finishDelivery, {
			id,
			generation,
			sent: false
		});
		await ctx.scheduler.runAt(data.expiresAt, internal.companyInvitations.expire, {
			id,
			expiresAt: data.expiresAt
		});
		return {
			id,
			generation,
			email,
			companyName: access.company.name,
			inviterName: access.name || access.email
		};
	}
});
export const expire = internalMutation({
	args: { id: v.id('companyInvitations'), expiresAt: v.number() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const invitation = await ctx.db.get('companyInvitations', args.id);
		if (
			invitation?.status === 'pending' &&
			invitation.expiresAt === args.expiresAt &&
			invitation.expiresAt <= Date.now()
		)
			await ctx.db.patch('companyInvitations', args.id, { expired: true });
		return null;
	}
});

// Initialize existing records once when deploying scheduled expiry.
export const initializeExpiration = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const result = await ctx.db
			.query('companyInvitations')
			.paginate({ cursor: args.cursor, numItems: 100 });
		for (const invitation of result.page) {
			if (invitation.status !== 'pending' || invitation.expired !== undefined) continue;
			const expired = invitation.expiresAt <= Date.now();
			await ctx.db.patch('companyInvitations', invitation._id, { expired });
			if (!expired)
				await ctx.scheduler.runAt(invitation.expiresAt, internal.companyInvitations.expire, {
					id: invitation._id,
					expiresAt: invitation.expiresAt
				});
		}
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.companyInvitations.initializeExpiration, {
				cursor: result.continueCursor
			});
		return null;
	}
});
export const finishDelivery = internalMutation({
	args: { id: v.id('companyInvitations'), generation: v.number(), sent: v.boolean() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const invitation = await ctx.db.get('companyInvitations', args.id);
		if (
			invitation?.status === 'pending' &&
			invitation.deliveryGeneration === args.generation &&
			(args.sent || invitation.deliveryStatus === 'sending')
		)
			await ctx.db.patch('companyInvitations', invitation._id, {
				deliveryStatus: args.sent ? 'sent' : 'failed'
			});
		return null;
	}
});
export const canDeliver = internalQuery({
	args: { id: v.id('companyInvitations'), generation: v.number() },
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const invitation = await ctx.db.get('companyInvitations', args.id);
		return Boolean(
			invitation?.status === 'pending' &&
			!invitation.expired &&
			invitation.deliveryStatus === 'sending' &&
			invitation.deliveryGeneration === args.generation &&
			(await availableCompany(ctx, invitation.companyId))
		);
	}
});

// The random email token permits a minimal preview, never membership access.
export const previewHash = internalQuery({
	args: { tokenHash: v.string() },
	returns: invitationPreviewData,
	handler: async (ctx, args): Promise<InvitationPreviewData> => {
		const invitation = await ctx.db
			.query('companyInvitations')
			.withIndex('by_tokenHash', (q) => q.eq('tokenHash', args.tokenHash))
			.unique();
		if (!invitation) return { status: 'unavailable' };
		const company = await availableCompany(ctx, invitation.companyId);
		if (!company) return { status: 'unavailable' };
		if (invitation.status !== 'pending') return { status: invitation.status };
		return {
			status: 'available',
			companyName: company.name,
			email: invitation.normalizedEmail,
			expiresAt: invitation.expiresAt
		};
	}
});

export const resolveHash = internalQuery({
	args: { tokenHash: v.string() },
	returns: invitationResolutionData,
	handler: async (ctx, args): Promise<InvitationResolutionData> => {
		const identity = await verifiedIdentity(ctx);
		const profile = await requireProfile(ctx);
		const invitation = await ctx.db
			.query('companyInvitations')
			.withIndex('by_tokenHash', (q) => q.eq('tokenHash', args.tokenHash))
			.unique();
		if (!invitation) return { status: 'unavailable', companyName: null };
		if (invitation.normalizedEmail !== emailAddress(identity.email!))
			return { status: 'wrong-email', companyName: null };
		const company = await availableCompany(ctx, invitation.companyId);
		if (!company) return { status: 'unavailable', companyName: null };
		const companyName = company.name;
		if (invitation.status === 'revoked') return { status: 'revoked', companyName };
		const membership = await ctx.db
			.query('memberships')
			.withIndex('by_profileId', (q) => q.eq('profileId', profile._id))
			.unique();
		const sameCompany = membership?.companyId === invitation.companyId;
		if (invitation.status === 'accepted')
			return { status: sameCompany ? 'already-member' : 'accepted', companyName };
		if (membership)
			return {
				status: sameCompany ? 'already-member' : 'other-company',
				companyName,
				expiresAt: invitation.expiresAt
			};
		return {
			status: 'available',
			invitationId: invitation._id,
			companyName,
			deliveryGeneration: invitation.deliveryGeneration,
			expiresAt: invitation.expiresAt
		};
	}
});
