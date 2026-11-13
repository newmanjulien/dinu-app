import { makeFunctionReference } from 'convex/server';
import type { Id } from './_generated/dataModel';

// Authored references keep these new internal functions usable without running deployment/codegen.
export const maintenanceRun = makeFunctionReference<
	'mutation',
	{ contractId: Id<'savedContracts'>; generation: number },
	null
>('discussionMaintenance:run');
export const maintenanceRepair = makeFunctionReference<
	'mutation',
	{ controlId: Id<'discussionUnreadControls'> },
	null
>('discussionMaintenance:repair');
export const maintenanceResumeDue = makeFunctionReference<'mutation', { cursor?: string }, null>(
	'discussionMaintenance:resumeDue'
);
export const operationResume = makeFunctionReference<
	'mutation',
	{ receiptId: Id<'operationReceipts'> },
	null
>('discussionOperations:resume');
export const operationExecute = makeFunctionReference<
	'mutation',
	{ receiptId: Id<'operationReceipts'> },
	null
>('discussionOperations:execute');
