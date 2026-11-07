'use node';

import { v } from 'convex/values';
import { internal } from './_generated/api';
import { action } from './_generated/server';
import { exportRequest } from './savedContractValidators';

/** Every new download has a stable attempt, including companies without HubSpot. */
export const generate = action({
	args: exportRequest.extend({ operationId: v.string() }).fields,
	returns: v.object({ url: v.string(), filename: v.string(), attemptId: v.id('hubspotExports') }),
	handler: (
		ctx,
		args
	): Promise<{
		url: string;
		filename: string;
		attemptId: import('./_generated/dataModel').Id<'hubspotExports'>;
	}> => ctx.runAction(internal.hubspotExportActions.generate, args)
});
