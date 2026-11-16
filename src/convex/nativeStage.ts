import { ConvexError, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import type { nativeStage } from './nativeStageValidators';

type NativeTable = 'contractDocuments' | 'contractChanges' | 'contractChangeDecisions';
type StagedRow = {
	companyId: Id<'company'>;
	contractId: Id<'savedContracts'>;
	stage?: Infer<typeof nativeStage>;
};

/** Stage metadata may disappear after adoption without changing immutable source identity. */
export function withoutNativeStage<T extends { stage?: unknown }>(row: T): Omit<T, 'stage'> {
	const { stage: _stage, ...value } = row;
	return value;
}

export function nativeResultNames(owner: Doc<'operationReceipts'>, table: NativeTable, id: string) {
	const seal = owner.nativeResult;
	return (
		!!seal &&
		(table === 'contractDocuments'
			? seal.documentId === id
			: table === 'contractChanges'
				? seal.changeIds.some((value) => value === id)
				: seal.decisionIds.some((value) => value === id))
	);
}

/** Membership is evidence only for the row's actual original stage owner. */
export function nativeResultOwns(
	owner: Doc<'operationReceipts'> | null,
	table: NativeTable,
	id: string,
	row: StagedRow
) {
	return !!(
		row.stage?.sealed &&
		owner?.state === 'complete' &&
		row.stage.receiptId === owner._id &&
		owner.companyId === row.companyId &&
		owner.contractId === row.contractId &&
		owner.nativeResult?.generation === row.stage.generation &&
		nativeResultNames(owner, table, id)
	);
}

export async function nativeReachable(
	ctx: QueryCtx,
	table: NativeTable,
	id: string,
	row: StagedRow
) {
	return (
		!row.stage ||
		nativeResultOwns(await ctx.db.get('operationReceipts', row.stage.receiptId), table, id, row)
	);
}

/** Staged data is private until the original atomic adoption names this exact row. */
export async function requireNativeReachability(
	ctx: QueryCtx,
	table: NativeTable,
	id: string,
	row: StagedRow
) {
	if (!(await nativeReachable(ctx, table, id, row)))
		throw new ConvexError('This staged contract result is unavailable.');
}

/** A delayed adoption must still own the exact pending generation and unit. */
export async function nativeAdoptionOwner(ctx: QueryCtx, row: Doc<'operationReceipts'>) {
	const live = await ctx.db.get('operationReceipts', row._id);
	const expected = row.preparation?.native,
		actual = live?.preparation?.native;
	return live?.state === 'preparing' &&
		expected &&
		actual &&
		live.key === row.key &&
		live.companyId === row.companyId &&
		live.contractId === row.contractId &&
		actual.generation === expected.generation &&
		actual.unit === expected.unit
		? live
		: null;
}
