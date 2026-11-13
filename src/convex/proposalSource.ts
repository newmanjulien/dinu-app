import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import type { Contract } from './contractState';
import type { DiscussionIndex } from './discussionIndex';
import type { ContractDocument } from '../lib/document/contract-document';
import { resolvedDiscussion } from './discussionService';
import { anchorPassage } from '../lib/discussions/anchors';
import type { ReplacementAtom, SourceTarget } from '../lib/document/source-model';
import { validateStructuralReplacementContent } from '../lib/playbook/validation';

export async function proposalRoot(
	ctx: QueryCtx,
	contract: Contract,
	index: DiscussionIndex,
	args: {
		threadId: Id<'discussionThreads'>;
		rootMessageId: Id<'discussionMessages'>;
		expectedRootRevision: number;
	}
) {
	const thread = await index.thread(args.threadId);
	if (!thread || thread.type !== 'proposal' || !(await index.interval(thread)))
		throw new ConvexError('This proposal is unavailable.');
	const root = await ctx.db
		.query('discussionMessages')
		.withIndex('by_threadId_and_reply', (q) => q.eq('threadId', thread._id).eq('reply', false))
		.unique();
	if (
		!root ||
		root.companyId !== contract.root.companyId ||
		root.contractId !== contract.root._id ||
		root._id !== args.rootMessageId ||
		root.reply ||
		root.deleted ||
		root.revision !== args.expectedRootRevision
	)
		throw new ConvexError('This proposal changed. Review the current wording.');
	return { thread, root };
}
export const currentDisplayIdentity = (
	root: Pick<Contract['root'], 'documentId' | 'documentRevision'>
) => `current:${root.documentId}:${root.documentRevision}`;
/** Resolve the exact surviving anchor against approved wording. No proposal option,
 * publication capture or candidate document participates in native normalization. */
export function normalizeProposal(
	document: ContractDocument,
	thread: Doc<'discussionThreads'>,
	root: Doc<'discussionMessages'>,
	contract: Contract['root']
) {
	const passage = anchorPassage(resolvedDiscussion(document), thread.anchor);
	if (!passage) throw new ConvexError('The exact passage for this proposal is unavailable.');
	function point(part: NonNullable<typeof passage>[number], offset: number) {
		const run = part.run,
			range = run.source;
		if (!range) throw new ConvexError('The proposal must select persisted contract wording.');
		const atomic = run.sourceKind === 'reference' || run.sourceKind === 'number';
		if (atomic && offset !== 0 && offset !== run.text.length)
			throw new ConvexError('Select the whole clause reference.');
		const local = range.start.offset + (atomic ? (offset === 0 ? 0 : 1) : offset);
		const piece = document.pieces.find((piece) => piece.sourceKey === range.start.sourceKey);
		return piece
			? { sourceKey: piece.origin.sourceKey, offset: piece.origin.start + local }
			: { sourceKey: range.start.sourceKey, offset: local };
	}
	const target: SourceTarget = {
		kind: 'text',
		range: {
			start: point(passage[0], passage[0].from),
			end: point(passage.at(-1)!, passage.at(-1)!.to)
		}
	};
	const text = root.text.replace(/\r\n?/gu, '\n');
	const replacement: ReplacementAtom[] = text
		.split('\n')
		.flatMap((text, i) => [
			...(i ? [{ kind: 'paragraph-break' as const }] : []),
			...(text ? [{ kind: 'text' as const, text }] : [])
		]);
	const changes = [{ target, replacement }];
	validateStructuralReplacementContent({ concessions: [{ changes }] }, true);
	return {
		changes,
		source: {
			author: { authorKey: root.authorKey, profileId: root.profileId ?? null },
			threadId: thread._id,
			rootMessageId: root._id,
			rootRevision: root.revision,
			text,
			anchor: thread.anchor,
			quote: passage.map((part) => part.run.text.slice(part.from, part.to)).join(''),
			documentId: contract.documentId,
			documentRevision: contract.documentRevision,
			displayIdentity: currentDisplayIdentity(contract)
		}
	};
}
