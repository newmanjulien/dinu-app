import { v, type Infer } from 'convex/values';
export { emailAddress } from './emailValidators';

const invitationFields = v.object({
	companyId: v.id('company'),
	normalizedEmail: v.string(),
	inviterProfileId: v.id('profiles'),
	tokenHash: v.string(),
	expiresAt: v.number(),
	expired: v.boolean(),
	deliveryStatus: v.union(v.literal('sending'), v.literal('sent'), v.literal('failed')),
	deliveryGeneration: v.number(),
	deliveryStartedAt: v.optional(v.number()),
	deliveryId: v.optional(v.id('emailDeliveries')),
	expiryJobId: v.optional(v.id('_scheduled_functions'))
});
export const storedInvitation = v.union(
	invitationFields.extend({ status: v.union(v.literal('pending'), v.literal('revoked')) }),
	invitationFields.extend({
		status: v.literal('accepted'),
		acceptedByProfileId: v.id('profiles'),
		acceptedAt: v.number()
	})
);

export const invitationDelivery = v.object({
	email: v.string(),
	error: v.union(v.string(), v.null())
});
export type InvitationDelivery = Infer<typeof invitationDelivery>;

const previewDetails = v.object({
	status: v.literal('available'),
	companyName: v.string(),
	email: v.string()
});
const previewUnavailable = v.object({
	status: v.union(
		v.literal('accepted'),
		v.literal('revoked'),
		v.literal('expired'),
		v.literal('unavailable')
	)
});
export const invitationPreviewData = v.union(
	previewDetails.extend({ expiresAt: v.number() }),
	previewUnavailable
);
export type InvitationPreviewData = Infer<typeof invitationPreviewData>;
export const invitationPreview = v.union(
	previewDetails.extend({ expiresInMs: v.number() }),
	previewUnavailable
);
export type InvitationPreview = Infer<typeof invitationPreview>;

const resolutionAvailable = v.object({
	status: v.literal('available'),
	invitationId: v.id('companyInvitations'),
	companyName: v.string(),
	deliveryGeneration: v.number()
});
const resolutionMembership = v.object({
	status: v.union(v.literal('already-member'), v.literal('other-company')),
	companyName: v.string()
});
const resolutionUnavailable = v.object({
	status: v.union(
		v.literal('wrong-email'),
		v.literal('accepted'),
		v.literal('revoked'),
		v.literal('expired'),
		v.literal('unavailable')
	),
	companyName: v.union(v.string(), v.null())
});
export const invitationResolution = v.union(
	resolutionAvailable,
	resolutionMembership,
	resolutionUnavailable
);
export type InvitationResolution = Infer<typeof invitationResolution>;
export const invitationResolutionData = v.union(
	resolutionAvailable.extend({ expiresAt: v.number() }),
	resolutionMembership.extend({ expiresAt: v.optional(v.number()) }),
	resolutionUnavailable
);
export type InvitationResolutionData = Infer<typeof invitationResolutionData>;
