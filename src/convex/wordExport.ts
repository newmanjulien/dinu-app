'use node';

import { type Infer } from 'convex/values';
import { action } from './_generated/server';
import { wordExportRequest } from './exportValidators';
import { wordExportResult } from './savedContractValidators';
import { generateWordExport } from './wordExportGeneration';

export const generate = action({
	args: wordExportRequest.fields,
	returns: wordExportResult,
	handler: (ctx, args): Promise<Infer<typeof wordExportResult>> => generateWordExport(ctx, args)
});
