'use node';

import { type Infer } from 'convex/values';
import { action } from './_generated/server';
import { wordExportRequest, wordExportResult } from './savedContractValidators';
import { generateWordExport } from './wordExportGeneration';

/** Every new download has a stable attempt, including companies without HubSpot. */
export const generate = action({
	args: wordExportRequest.fields,
	returns: wordExportResult,
	handler: (
		ctx,
		args
	): Promise<Infer<typeof wordExportResult>> => generateWordExport(ctx, args)
});
