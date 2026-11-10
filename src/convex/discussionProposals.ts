import { validateStorageArrays } from '../lib/document/storage-limits';
import { ConvexError, v } from 'convex/values';
import { mutation } from './_generated/server';
import { seller } from './buyerLinks';
import { composedContract } from './discussionService';
import { anchorPassage } from '../lib/discussions/anchors';
import type { DiscussionAnchor, DiscussionPoint } from '../lib/discussions/validators';
import type { ContractItemId } from '../lib/contract/item-identity';
import type { ContractChange } from '../lib/playbook/model';
import type { ReplacementAtom, SourceTarget } from '../lib/document/source-model';
import { referenceText } from '../lib/document/numbering';
import { choicesOf } from '../lib/contract/applications';
import { saveReplacement } from './contractSaving';
import { changesConflict } from '../lib/playbook/conflicts';
import { validateTarget } from '../lib/document/ranges';
import { actionKey, receipt, remember } from './hubspotRecords';
import {
	validateChangeReferences,
	validateStructuralReplacementContent
} from '../lib/playbook/validation';
import { assertStorageCapacity, documentBytes } from './storageCapacity';

export const apply = mutation({
	args: {
		membershipId: v.id('memberships'),
		id: v.id('savedContracts'),
		threadId: v.id('discussionThreads'),
		expectedMessageRevision: v.number(),
		expectedEditRevision: v.number(),
		operationId: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		const { contract, access } = await seller(ctx, args);
		const key = actionKey(access, 'proposal', args.operationId),
			inputs = JSON.stringify(args);
		if (await receipt(ctx, key, inputs)) return null;
		if (contract.editRevision !== args.expectedEditRevision)
			throw new ConvexError(
				'This contract changed. Review the proposal against the current wording.'
			);
		const thread = await ctx.db.get('discussionThreads', args.threadId);
		if (
			!thread ||
			thread.companyId !== contract.companyId ||
			thread.contractId !== contract._id ||
			thread.type !== 'proposal'
		)
			throw new ConvexError('This proposal is unavailable.');
		const root = await ctx.db
			.query('discussionMessages')
			.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', thread._id).eq('reply', false))
			.unique();
		if (!root || root.deleted || root.revision !== args.expectedMessageRevision)
			throw new ConvexError('This proposal changed. Review its current wording.');
		// The contract-scoped receipt below also deduplicates other workspace members.
		const duplicate = await ctx.db
			.query('proposalApplications')
			.withIndex('by_threadId_and_revision', (q) =>
				q.eq('threadId', thread._id).eq('revision', root.revision)
			)
			.unique();
		if (duplicate) {
			await remember(ctx, contract.companyId, key, inputs, 'applied');
			return null;
		}
		const composed = await composedContract(ctx, contract);
		const atomLength = (atom: ReplacementAtom) =>
			atom.kind === 'text'
				? atom.text.length
				: atom.kind === 'paragraph-break'
					? 1
					: referenceText(atom, composed.engine.addresses).length;
		let anchor: DiscussionAnchor = thread.anchor;
		const previous = await ctx.db
			.query('proposalApplications')
			.withIndex('by_threadId_and_revision', (q) => q.eq('threadId', thread._id))
			.order('desc')
			.first();
		if (previous && contract.applications[previous.itemId]) {
			const item = composed.items.find((i) => i._id === previous.itemId);
			const concession = item?.concessions.find(
				(c) => c.id === contract.applications[previous.itemId].concessionId
			);
			if (concession) {
				const from = concession.changes[0].replacement
					.slice(0, previous.prefixAtoms)
					.reduce((n, a) => n + atomLength(a), 0);
				const origin = { itemId: previous.itemId, concessionId: concession.id, changeIndex: 0 };
				anchor = {
					start: { kind: 'replacement', origin, offset: from },
					end: { kind: 'replacement', origin, offset: from + previous.proposalText.length },
					quote: previous.proposalText
				};
			}
		}
		const passage = anchorPassage(composed.resolved, anchor);
		if (!passage)
			throw new ConvexError(
				'The wording for this proposal changed. Create a proposal against the current passage.'
			);
		const active = new Map(composed.items.map((item) => [String(item._id), item]));
		function changeFor(point: Extract<DiscussionPoint, { kind: 'replacement' }>) {
			const item = active.get(point.origin.itemId),
				choice = contract.applications[point.origin.itemId];
			const change = item?.concessions.find(
				(c) => c.id === choice?.concessionId && c.id === point.origin.concessionId
			)?.changes[point.origin.changeIndex];
			if (!change) throw new ConvexError('This proposed passage was replaced.');
			return change;
		}
		function sliceAtoms(atoms: readonly ReplacementAtom[], from: number, to: number) {
			const result: ReplacementAtom[] = [];
			let offset = 0;
			for (const atom of atoms) {
				const length = atomLength(atom),
					start = Math.max(0, from - offset),
					end = Math.min(length, to - offset);
				if (end > start) {
					if (atom.kind === 'text')
						result.push({ kind: 'text', text: atom.text.slice(start, end) });
					else {
						if (start !== 0 || end !== length)
							throw new ConvexError('Select the whole clause reference before proposing a change.');
						result.push(atom);
					}
				}
				offset += length;
			}
			return result;
		}
		const startChange = anchor.start.kind === 'replacement' ? changeFor(anchor.start) : null,
			endChange = anchor.end.kind === 'replacement' ? changeFor(anchor.end) : null;
		const expanded: DiscussionAnchor = {
			...anchor,
			start: anchor.start.kind === 'replacement' ? { ...anchor.start, offset: 0 } : anchor.start,
			end:
				anchor.end.kind === 'replacement'
					? {
							...anchor.end,
							offset: endChange!.replacement.reduce((n, a) => n + atomLength(a), 0)
						}
					: anchor.end
		};
		const expandedPassage = anchorPassage(composed.resolved, expanded, false);
		if (!expandedPassage) throw new ConvexError('The proposed passage cannot be resolved.');
		let target: SourceTarget;
		if (startChange?.target.kind === 'boundary' || endChange?.target.kind === 'boundary') {
			if (
				!startChange ||
				!endChange ||
				JSON.stringify(startChange.target) !== JSON.stringify(endChange.target)
			)
				throw new ConvexError(
					'Propose changes to inserted paragraphs separately from the surrounding wording.'
				);
			target = startChange.target;
		} else {
			const start =
				anchor.start.kind === 'source'
					? anchor.start.point
					: startChange!.target.kind === 'text'
						? startChange!.target.range.start
						: null;
			const end =
				anchor.end.kind === 'source'
					? anchor.end.point
					: endChange!.target.kind === 'text'
						? endChange!.target.range.end
						: null;
			if (!start || !end) throw new ConvexError('This proposed passage is unavailable.');
			target = { kind: 'text', range: { start, end } };
		}
		const sourceAtoms = new Map(
			composed.blocks.flatMap((block) =>
				block.kind === 'paragraph'
					? block.content.map((atom) => [atom.sourceKey, atom] as const)
					: []
			)
		);
		const expandedAtoms: ReplacementAtom[] = [];
		let offset = 0,
			selectedFrom = -1,
			selectedTo = -1,
			lastParagraph = expandedPassage[0].paragraph;
		for (const part of expandedPassage) {
			if (lastParagraph !== part.paragraph) {
				for (let i = lastParagraph; i < part.paragraph; i++) {
					expandedAtoms.push({ kind: 'paragraph-break' });
					offset++;
				}
			}
			if (part.run === passage[0].run) selectedFrom = offset + passage[0].from - part.from;
			if (part.run === passage.at(-1)!.run) selectedTo = offset + passage.at(-1)!.to - part.from;
			const run = part.run;
			if (run.generatedOrigin && run.generatedOffset !== undefined) {
				const original = changeFor({
					kind: 'replacement',
					origin: { ...run.generatedOrigin, itemId: run.generatedOrigin.itemId as ContractItemId },
					offset: 0
				});
				expandedAtoms.push(
					...sliceAtoms(
						original.replacement,
						run.generatedOffset + part.from,
						run.generatedOffset + part.to
					)
				);
			} else if (run.sourceKind === 'reference' && run.source) {
				const atom = sourceAtoms.get(run.source.start.sourceKey);
				if (!atom || atom.kind !== 'reference' || part.from !== 0 || part.to !== run.text.length)
					throw new ConvexError('Select the whole clause reference.');
				const { sourceKey: _key, ...reference } = atom;
				expandedAtoms.push(reference);
			} else expandedAtoms.push({ kind: 'text', text: run.text.slice(part.from, part.to) });
			offset += part.to - part.from;
			lastParagraph = part.paragraph;
		}
		if (selectedFrom < 0 || selectedTo < selectedFrom)
			throw new ConvexError('This proposed passage is unavailable.');
		const proposed: ReplacementAtom[] = root.text
			.replace(/\r\n?/gu, '\n')
			.split('\n')
			.flatMap((text, i) => [
				...(i ? [{ kind: 'paragraph-break' as const }] : []),
				...(text ? [{ kind: 'text' as const, text }] : [])
			]);
		const prefix = sliceAtoms(expandedAtoms, 0, selectedFrom);
		const replacement = [...prefix, ...proposed, ...sliceAtoms(expandedAtoms, selectedTo, offset)];
		const owners = new Set<ContractItemId>();
		const inherited: ContractChange[] = [];
		for (const item of composed.items) {
			const choice = contract.applications[item._id],
				changes = item.concessions.find((c) => c.id === choice?.concessionId)!.changes;
			if (changes.some((c) => changesConflict(composed.engine.index, c, { target }))) {
				owners.add(item._id);
				inherited.push(
					...changes.filter((c) => !changesConflict(composed.engine.index, c, { target }))
				);
			}
		}
		const changes: ContractChange[] = [{ target, replacement }, ...inherited];
		if (changes.length > 64)
			throw new ConvexError('This proposal affects too many contract changes.');
		for (const [i, change] of changes.entries()) {
			validateTarget(composed.engine.index, change.target);
			for (const other of changes.slice(0, i))
				if (changesConflict(composed.engine.index, change, other))
					throw new ConvexError('This proposal conflicts with another effect.');
		}
		const definition = {
			companyId: contract.companyId,
			contractId: contract._id,
			contentRevision: 1,
			proposalId: thread._id,
			approvalPolicy: {
				kind: 'required' as const,
				instructions: 'Review the proposed contract wording.'
			},
			trigger: { id: args.operationId, target },
			concessions: [
				{ id: args.operationId, tier: 'rare' as const, description: root.text, changes }
			]
		};
		const compiled = composed.compiled;
		validateChangeReferences(compiled, definition);
		validateStructuralReplacementContent(definition);
		validateStorageArrays(definition);
		const bytes = documentBytes(definition);
		if (bytes > 500_000) throw new ConvexError('This proposal is too large.');
		await assertStorageCapacity(ctx, { documents: 3, bytes: bytes + 20_000 });
		const itemId = await ctx.db.insert('contractConcessions', definition);

		const applicationId = `proposal:${args.operationId}`;
		const choices = choicesOf(contract.applications);
		for (const id of owners) delete choices[id];
		choices[itemId] = { concessionId: args.operationId, applicationId };
		await saveReplacement(
			ctx,
			access,
			contract,
			choices,
			itemId,
			args.operationId,
			composed.reader
		);
		await ctx.db.insert('proposalApplications', {
			companyId: contract.companyId,
			contractId: contract._id,
			threadId: thread._id,
			revision: root.revision,
			proposalText: root.text.replace(/\r\n?/gu, '\n'),
			prefixAtoms: prefix.length,
			itemId
		});
		await ctx.db.patch('discussionThreads', thread._id, { applied: true });
		await remember(ctx, contract.companyId, key, inputs, 'applied');
		return null;
	}
});
