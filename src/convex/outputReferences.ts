import { makeFunctionReference } from 'convex/server';
import type { Id } from './_generated/dataModel';

/** Authored references keep local, read-only compilation independent of deployment codegen. */
export const outputProgress = makeFunctionReference<
	'mutation',
	{ receiptId: Id<'operationReceipts'> },
	boolean
>('outputReservations:progress');
export const outputVerify = makeFunctionReference<
	'mutation',
	{ receiptId: Id<'operationReceipts'> },
	boolean
>('outputReservations:verify');
export const outputActivateWord = makeFunctionReference<
	'mutation',
	{ receiptId: Id<'operationReceipts'> },
	null
>('contractExports:activatePrepared');

export const outputActivateQuote = makeFunctionReference<
	'mutation',
	{ receiptId: Id<'operationReceipts'> },
	null
>('hubspotQuotes:activatePrepared');
export const outputCheckQuote = makeFunctionReference<
	'mutation',
	{ receiptId: Id<'operationReceipts'> },
	null
>('hubspotQuotes:checkPrepared');
