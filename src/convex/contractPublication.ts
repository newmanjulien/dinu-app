import { publicProjection } from './buyerProjection';
import { releasedRecord, releasedEntries } from '../lib/contract/released-selections';
import { documentBytes, assertStorageCapacity } from './storageCapacity';
import { ConvexError } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { contractReader } from './contractReader';
import { concessionSelections } from '../lib/contract/applications';
import { sameSelection } from '../lib/playbook/model';
import { CompiledDocument } from '../lib/document/compiled-document';
import { iterateChangeConflicts } from '../lib/playbook/conflicts';
import { complete } from '../lib/document/iteration';
import type { ContractItemId } from '../lib/contract/item-identity';

export function publicationFor(ctx: QueryCtx, id: Doc<'savedContracts'>['_id']) {
	return ctx.db
		.query('contractBuyerState')
		.withIndex('by_contractId', (q) => q.eq('contractId', id))
		.unique();
}
export function linkFor(ctx: QueryCtx, id: Doc<'savedContracts'>['_id']) {
	return ctx.db
		.query('buyerLinks')
		.withIndex('by_contractId', (q) => q.eq('contractId', id))
		.unique();
}
export function acknowledgmentFor(
	ctx: QueryCtx,
	contractId: Doc<'savedContracts'>['_id'],
	profileId: Doc<'profiles'>['_id']
) {
	return ctx.db
		.query('publicationAcknowledgments')
		.withIndex('by_contractId_and_profileId', (q) =>
			q.eq('contractId', contractId).eq('profileId', profileId)
		)
		.unique();
}
export async function requirePublicationAcknowledgment(
	ctx: QueryCtx,
	contract: Doc<'savedContracts'>,
	profileId: Doc<'profiles'>['_id']
) {
	if (
		(await linkFor(ctx, contract._id)) &&
		!(await acknowledgmentFor(ctx, contract._id, profileId))
	)
		throw new ConvexError({
			code: 'PUBLICATION_CONFIRMATION_REQUIRED',
			message:
				'This contract has a published buyer link. Confirm that approved changes will be visible to the buyer.'
		});
}

/** One transaction advances only conflict-connected groups whose replacements are eligible.
 * Released identity is independent of current review status: resets never retract wording.
 */
export async function publishContract(
	ctx: MutationCtx,
	contract: Doc<'savedContracts'>,
	prepared?: Awaited<ReturnType<typeof contractReader>>,
	compiled?: CompiledDocument
) {
	const previous = await publicationFor(ctx, contract._id);
	if (!previous) {
		await ctx.db.insert('contractBuyerState', {
			companyId: contract.companyId,
			contractId: contract._id,
			templateVersionId: contract.templateVersionId,
			title: contract.buyerCompanyName,
			selections: [],
			buyerRevision: 0
		});
		if (Object.keys(contract.applications).length)
			await publishContract(ctx, contract, prepared, compiled);
		return;
	}
	const working = concessionSelections(contract.applications),
		released = releasedRecord(previous.selections);
	let next = released;
	if (!sameSelection(working, released)) {
		const ids = [
			...new Set([...Object.keys(working), ...Object.keys(released)])
		] as ContractItemId[];
		const parents = new Map(ids.map((id) => [id, id]));
		const find = (id: ContractItemId): ContractItemId => {
			let root = id;
			while (parents.get(root) !== root) root = parents.get(root)!;
			while (id !== root) {
				const parent = parents.get(id)!;
				parents.set(id, root);
				id = parent;
			}
			return root;
		};
		const changed = ids.filter((id) => working[id] !== released[id]);
		const blocked = changed.filter(
			(id) =>
				working[id] !== undefined &&
				contract.applications[id]?.approval &&
				contract.applications[id].approval!.status !== 'approved'
		);
		if (!blocked.length) next = working;
		else if (!Object.keys(released).length)
			next = Object.fromEntries(
				Object.entries(working).filter(([id]) => !blocked.includes(id as ContractItemId))
			);
		else {
			const reader = prepared ?? (await contractReader(ctx, contract));
			const [oldItems, newItems] = await Promise.all([
				reader.releasedItems(released),
				reader.selectedItems(working)
			]);
			if (oldItems.length) {
				const index = (compiled ?? (await reader.compiled())).index;
				const variants = [
					...oldItems.map((item) => ({ item, choice: released[item._id] })),
					...newItems.map((item) => ({ item, choice: working[item._id] }))
				];
				const changes = variants.flatMap(({ item, choice }) =>
					item.concessions
						.find((c) => c.id === choice)!
						.changes.map((change) => ({ ...change, owner: item._id }))
				);
				complete(
					iterateChangeConflicts(index, changes, {
						groups: changes.map((c) => c.owner),
						onConflict: (a, b) => {
							const x = find(changes[a].owner),
								y = find(changes[b].owner);
							if (x !== y) parents.set(x, y);
						}
					})
				);
			}
			const blockedRoots = new Set(blocked.map(find));
			next = { ...released };
			for (const id of changed)
				if (!blockedRoots.has(find(id))) {
					if (working[id] === undefined) delete next[id];
					else next[id] = working[id];
				}
		}
	}
	if (sameSelection(next, released) && previous.title === contract.buyerCompanyName) return;
	const selections = releasedEntries(next);
	const prospective = {
		...previous,
		selections,
		title: contract.buyerCompanyName,
		buyerRevision: previous.buyerRevision + 1
	};
	const reader =
		prepared ?? (Object.keys(next).length ? await contractReader(ctx, contract) : undefined);
	// Validate the actual selected DTO before committing the publication, including
	// historical definitions retained beside the bounded working selection.
	const items = reader ? await reader.releasedItems(next) : [];
	publicProjection(prospective, items);
	const bytes = documentBytes(prospective);
	reader?.validatePublicationRead(items, bytes);
	await assertStorageCapacity(ctx, { documents: 1, bytes });
	await ctx.db.patch('contractBuyerState', previous._id, {
		selections,
		title: contract.buyerCompanyName,
		buyerRevision: previous.buyerRevision + 1
	});
}
