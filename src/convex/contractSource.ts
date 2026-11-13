import { ConvexError } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { seller, type Contract } from './contractState';
import { canonicalJson } from '../lib/document/canonical-json';
import { contractWorkBlock } from './contractPolicy';
import { workBlockMessage } from '../lib/contract/work-policy';
import { contractReadinessState } from './reviews';
import { assertContractDocumentManifest } from './contractDocuments';
import { requireNativeReachability } from './nativeStage';
import type { ExpectedContractSource } from './contractSourceValidators';
export { sourceExpectation, type ExpectedContractSource } from './contractSourceValidators';

export function expectedSourceOf(contract: Contract): ExpectedContractSource {
	return {
		stateRevision: contract.root.stateRevision,
		documentId: contract.root.documentId,
		documentRevision: contract.root.documentRevision,
		title: contract.root.title,
		templateVersionId: contract.root.templateVersionId
	};
}
export const staleSource = () =>
	new ConvexError({
		code: 'STALE_SOURCE',
		message: 'The saved contract changed. Review the current contract and try again.'
	});
export function requireExpectedSource(contract: Contract, expected: ExpectedContractSource) {
	if (canonicalJson(expectedSourceOf(contract)) !== canonicalJson(expected)) throw staleSource();
}
/** Readiness never constructs evidence or enumerates native heads. */
export async function readContractSource(ctx: QueryCtx, contract: Contract) {
	const readiness = await contractReadinessState(ctx, contract);
	const workBlock = await contractWorkBlock(ctx, contract);
	return {
		expectedSource: expectedSourceOf(contract),
		ready: readiness.ready && !workBlock,
		blockerCount: readiness.blockerCount,
		workBlock
	};
}
export async function requireReadySource(ctx: QueryCtx, contract: Contract) {
	const source = await readContractSource(ctx, contract);
	if (!source.ready)
		throw new ConvexError({
			code: source.workBlock ?? 'APPROVAL_REQUIRED',
			message: source.workBlock
				? workBlockMessage(source.workBlock)
				: 'Approve or withdraw the current required changes before continuing.'
		});
	return source;
}
export async function sourceDocument(ctx: QueryCtx, contract: Contract) {
	const manifest = await ctx.db.get('contractDocuments', contract.root.documentId);
	assertContractDocumentManifest(manifest, {
		companyId: contract.root.companyId,
		contractId: contract.root._id
	});
	await requireNativeReachability(ctx, 'contractDocuments', manifest._id, manifest);
	return manifest;
}
export async function currentSource(
	ctx: QueryCtx,
	args: { membershipId: Id<'memberships'>; id: Id<'savedContracts'> }
) {
	const { contract, access } = await seller(ctx, args);
	return { contract, access, source: await readContractSource(ctx, contract) };
}
