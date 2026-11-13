import { ConvexError, type Infer } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import type { nativeStage } from './nativeStageValidators';

/** Staged data is private until the original atomic adoption names this exact row. */
export async function requireNativeReachability(
	ctx: QueryCtx,
	table: 'contractDocuments' | 'contractChanges' | 'contractChangeDecisions',
	id: string,
	row: {
		companyId: Id<'company'>;
		contractId: Id<'savedContracts'>;
		stage?: Infer<typeof nativeStage>;
	}
) {
	if (!row.stage) return;
	const owner = await ctx.db.get('operationReceipts', row.stage.receiptId);
	const seal = owner?.nativeResult;
	if (
		!row.stage.sealed ||
		!owner ||
		owner.state !== 'complete' ||
		owner.companyId !== row.companyId ||
		owner.contractId !== row.contractId ||
		!seal ||
		seal.generation !== row.stage.generation ||
		!(table === 'contractDocuments'
			? seal.documentId === id
			: table === 'contractChanges'
				? seal.changeIds.some((value) => value === id)
				: seal.decisionIds.some((value) => value === id))
	)
		throw new ConvexError('This staged contract result is unavailable.');
}
