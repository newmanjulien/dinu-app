import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { action, internalQuery, type QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import schema from './schema';
import { seller } from './contractState';
import { changeHead } from './contractChanges';
import { requireNativeReachability } from './nativeStage';
import { decodeContractDocumentChunks, assertContractDocumentManifest } from './contractDocuments';
import { changeReview } from '../lib/contract/changes';
import { storedContractChangeHead } from './contractChangeValidators';
import type { DocumentChange } from '../lib/document/contract-document';
import { canonicalJson } from '../lib/document/canonical-json';
import { reviewOf } from './reviews';

const detailArgs = {
	membershipId: v.id('memberships'),
	id: v.id('savedContracts'),
	changeId: v.id('contractChanges'),
	documentId: v.id('contractDocuments')
};
const fence = v.object({ head: storedContractChangeHead, admin: v.boolean() });
type DetailArgs = {
	membershipId: Id<'memberships'>;
	id: Id<'savedContracts'>;
	changeId: Id<'contractChanges'>;
	documentId: Id<'contractDocuments'>;
};
const headFence = (row: Doc<'contractChangeHeads'>, admin: boolean) => {
	const { _id, _creationTime, ...head } = row;
	return { head, admin };
};
async function sourceState(ctx: QueryCtx, args: DetailArgs) {
	const { access, contract } = await seller(ctx, args);
	if (contract.root.documentId !== args.documentId) return null;
	const row = await ctx.db.get('contractChanges', args.changeId);
	if (!row || row.contractId !== args.id || row.companyId !== access.companyId) return null;
	await requireNativeReachability(ctx, 'contractChanges', row._id, row);
	const selected = await changeHead(ctx, contract, row.kind, row.key);
	if (!selected || ![selected.current?._id, selected.applied?._id].includes(row._id)) return null;
	const manifest = await ctx.db.get('contractDocuments', args.documentId);
	if (!manifest || manifest.contractId !== args.id || manifest.companyId !== access.companyId)
		return null;
	assertContractDocumentManifest(manifest, { companyId: access.companyId, contractId: args.id });
	await requireNativeReachability(ctx, 'contractDocuments', manifest._id, manifest);
	return {
		contract,
		admin: access.membership.role === 'admin',
		current: selected.current,
		applied: selected.applied,
		head: selected.head,
		fence: headFence(selected.storedHead, access.membership.role === 'admin'),
		manifest
	};
}
export const source = internalQuery({
	args: detailArgs,
	returns: v.union(v.null(), v.string()),
	handler: async (ctx, args) => {
		const state = await sourceState(ctx, args);
		return state ? JSON.stringify(state) : null;
	}
});
type SourceState = NonNullable<Awaited<ReturnType<typeof sourceState>>>;
type Fence = SourceState['fence'];
/** Each immutable page reauthorizes the caller and checks exact mutable references.
 * Final source validation additionally resolves live floating-support eligibility. */
export const page = internalQuery({
	args: {
		...detailArgs,
		fence,
		kind: v.union(v.literal('document'), v.literal('patch')),
		offset: v.number()
	},
	returns: v.union(
		v.null(),
		v.array(schema.doc('contractDocumentChunks')),
		v.array(schema.doc('contractChangeContents'))
	),
	handler: async (ctx, args) => {
		const { contract, access } = await seller(ctx, args);
		if (!Number.isSafeInteger(args.offset) || args.offset < 0)
			throw new Error('Invalid review detail cursor.');
		if (contract.root.documentId !== args.documentId) return null;
		const head = await ctx.db
			.query('contractChangeHeads')
			.withIndex('by_contractId_and_kind_and_key', (q) =>
				q.eq('contractId', args.id).eq('kind', args.fence.head.kind).eq('key', args.fence.head.key)
			)
			.unique();
		if (
			!head ||
			head.companyId !== access.companyId ||
			canonicalJson(headFence(head, access.membership.role === 'admin')) !==
				canonicalJson(args.fence)
		)
			return null;
		if (args.kind === 'document') {
			const manifest = await ctx.db.get('contractDocuments', args.documentId);
			if (!manifest || manifest.companyId !== access.companyId || manifest.contractId !== args.id)
				return null;
			assertContractDocumentManifest(manifest, {
				companyId: access.companyId,
				contractId: args.id
			});
			await requireNativeReachability(ctx, 'contractDocuments', manifest._id, manifest);
			const rows = await Promise.all(
				manifest.chunkIds
					.slice(args.offset, args.offset + 4)
					.map((id) => ctx.db.get('contractDocumentChunks', id))
			);
			if (
				rows.some((row) => !row || row.contractId !== args.id || row.companyId !== access.companyId)
			)
				throw new Error('Review document page is incomplete.');
			return rows as Doc<'contractDocumentChunks'>[];
		}
		if (![head.current?.changeId, head.applied?.changeId].includes(args.changeId)) return null;
		const change = await ctx.db.get('contractChanges', args.changeId);
		if (
			!change ||
			change.companyId !== access.companyId ||
			change.contractId !== args.id ||
			change.kind !== head.kind ||
			change.key !== head.key
		)
			return null;
		await requireNativeReachability(ctx, 'contractChanges', change._id, change);
		const count = Math.min(4, change.chunks - args.offset);
		if (count < 0 || change.chunks < 1 || change.chunks > 64)
			throw new Error('Invalid review patch manifest.');
		const rows = await ctx.db
			.query('contractChangeContents')
			.withIndex('by_changeId_and_order', (q) =>
				q.eq('changeId', change._id).gte('order', args.offset)
			)
			.take(count);
		if (
			rows.length !== count ||
			rows.some(
				(row, i) =>
					row.order !== args.offset + i ||
					row.companyId !== access.companyId ||
					row.contractId !== args.id
			)
		)
			throw new Error('Review patch page is incomplete.');
		return rows;
	}
});
const sourceRef = makeFunctionReference<'query', DetailArgs, string | null>('reviewDetails:source');
const pageRef = makeFunctionReference<
	'query',
	DetailArgs & { fence: Fence; kind: 'document' | 'patch'; offset: number },
	Doc<'contractDocumentChunks'>[] | Doc<'contractChangeContents'>[] | null
>('reviewDetails:page');
/** Focused exceptional detail: no database transaction reads the whole document+patch.
 * It never writes business state and its result is bound to the original native page. */
export const detail = action({
	args: detailArgs,
	returns: v.union(v.null(), changeReview),
	handler: async (ctx, args) => {
		const encoded = await ctx.runQuery(sourceRef, args);
		if (!encoded) return null;
		const state = JSON.parse(encoded) as SourceState,
			row = [state.current, state.applied].find((row) => row?._id === args.changeId);
		if (!row || row.chunks < 1 || row.chunks > 64 || row.dataBytes > 8_000_000)
			throw new Error('Invalid review patch manifest.');
		const chunks: Doc<'contractDocumentChunks'>[] = [];
		for (let offset = 0; offset < state.manifest.chunkIds.length; offset += 4) {
			const rows = await ctx.runQuery(pageRef, {
				...args,
				fence: state.fence,
				kind: 'document',
				offset
			});
			if (!rows) return null;
			chunks.push(...(rows as Doc<'contractDocumentChunks'>[]));
		}
		const document = decodeContractDocumentChunks(state.manifest, chunks),
			parts: string[] = [];
		for (let offset = 0; offset < row.chunks; offset += 4) {
			const rows = await ctx.runQuery(pageRef, {
				...args,
				fence: state.fence,
				kind: 'patch',
				offset
			});
			if (!rows) return null;
			parts.push(...(rows as Doc<'contractChangeContents'>[]).map((row) => row.data));
		}
		const data = parts.join(''),
			patch = JSON.parse(data) as DocumentChange;
		if (
			new TextEncoder().encode(data).length !== row.dataBytes ||
			patch.id !== row.patchKey ||
			!Array.isArray(patch.parts) ||
			!Array.isArray(patch.dependencies)
		)
			throw new Error('Review patch integrity failed.');
		const result = reviewOf(
				state.contract,
				state.admin,
				state.head,
				state.current,
				state.applied,
				row,
				document,
				patch
			),
			finalEncoded = await ctx.runQuery(sourceRef, args);
		if (!finalEncoded) return null;
		const final = JSON.parse(finalEncoded) as SourceState;
		if (
			canonicalJson(final.fence) !== canonicalJson(state.fence) ||
			final.current?._id !== state.current?._id ||
			final.applied?._id !== state.applied?._id ||
			canonicalJson(final.head) !== canonicalJson(state.head) ||
			final.manifest.fingerprint !== state.manifest.fingerprint
		)
			return null;
		return result;
	}
});
