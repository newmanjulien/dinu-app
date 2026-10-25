import { v, type Infer } from 'convex/values';
export { emailAddress } from './emailValidators';

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
