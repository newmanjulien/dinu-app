import { v } from 'convex/values';
import { hubspotDestination } from './hubspotValidators';

export const hubspotExportDelivery = v.object({
	companyId: v.id('company'),
	attemptId: v.id('wordExports'),
	destination: hubspotDestination,
	attachmentUntil: v.optional(v.number()),
	remoteFileId: v.optional(v.string())
});
