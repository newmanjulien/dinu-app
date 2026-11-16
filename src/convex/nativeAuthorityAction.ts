import { ConvexError, v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { NativeOwner } from './nativeConstruction';
import type { AuthoritySnapshot } from './nativeAuthority';
import {
	nativeDocument,
	nativePatch,
	uploadNativeDocument,
	uploadNativePatch,
	uploadNativeGeometry,
	ObsoleteNativeUnit
} from './nativeConstructionAction';
import {
	prepareDocumentChange,
	applyDocumentChange,
	reverseDocumentChange,
	DocumentChangeConflict
} from '../lib/document/contract-document';
import { discussionTape } from '../lib/discussions/tape';
import { normalizeProposal } from './proposalSource';

const snapshot = makeFunctionReference<'query', NativeOwner, string | null>(
	'nativeAuthority:snapshot'
);
const checkpoint = makeFunctionReference<
	'mutation',
	NativeOwner & {
		value:
			| {
					kind: 'constructed';
					documentId?: Id<'contractDocuments'>;
					changeId?: Id<'contractChanges'>;
					tapeLength: number;
			  }
			| { kind: 'compared'; incompatible: boolean };
	},
	null
>('nativeAuthority:checkpoint');
const fail = makeFunctionReference<'mutation', NativeOwner & { error: string }, null>(
	'nativePlanPreparation:failSource'
);

/** One source document and one immutable patch per unit; paged IO and uploads are
 * owned by the original receipt, reauthorized/fenced at every query/checkpoint. */
export const construct = internalAction({
	args: { receiptId: v.id('operationReceipts'), generation: v.number(), unit: v.number() },
	returns: v.null(),
	handler: async (ctx, owner) => {
		try {
			const encoded = await ctx.runQuery(snapshot, owner);
			if (!encoded) return null;
			const s = JSON.parse(encoded) as AuthoritySnapshot,
				b = s.build;
			if (b.phase === 'patch') {
				const document = await nativeDocument(ctx, owner, 'source');
				let documentId: Id<'contractDocuments'> | undefined,
					changeId: Id<'contractChanges'> | undefined;
				if (s.input.kind === 'change-decision') {
					const action = s.input.args.action,
						status = s.target.head!.head.status;
					if (action === 'undo' || (action === 'approve' && status !== 'approved')) {
						const change = await nativePatch(ctx, owner, 'patch');
						const next =
							action === 'undo'
								? reverseDocumentChange(document, change.patch)
								: applyDocumentChange(document, change.patch);
						documentId = await uploadNativeDocument(ctx, owner, 'candidate', next);
					}
				} else if (!('changeId' in s.input.args)) {
					const source = s.target.source!,
						current = s.target.head?.current;
					const alreadySupported =
						current?.kind === 'buyer-link' &&
						current.source.rootMessageId === source.root._id &&
						current.source.rootRevision === source.root.revision &&
						s.target.head?.head.status !== 'rejected';
					if (!alreadySupported) {
						const normalized = normalizeProposal(document, source.thread, source.root, s.root);
						const patch = prepareDocumentChange(document, normalized.changes, s.key);
						patch.annotationKind = 'buyer-link';
						const next = applyDocumentChange(document, patch);
						changeId = await uploadNativePatch(
							ctx,
							owner,
							{
								companyId: s.root.companyId,
								contractId: s.root._id,
								kind: 'buyer-link',
								key: source.thread._id,
								operationId: s.key,
								patchKey: s.key,
								actor: s.actor,
								createdAt: s.createdAt,
								predecessorId: s.target.head?.applied?._id,
								policy: 'required',
								source: normalized.source
							},
							patch
						);
						// Snapshot is built by a reauthorized seller query. Admin support is an
						// approval; rep support retains the current approved document.
						if (s.admin) documentId = await uploadNativeDocument(ctx, owner, 'candidate', next);
					}
				}
				await ctx.runMutation(checkpoint, {
					...owner,
					value: {
						kind: 'constructed',
						documentId,
						changeId,
						tapeLength: discussionTape(document).length
					}
				});
			} else if (b.phase === 'compare') {
				const other = s.scan?.row;
				let incompatible = false;
				if (
					other?.current?.changeId &&
					other.current.changeId !== other.applied?.changeId &&
					s.scan?.nextStatus !== 'approved'
				) {
					try {
						applyDocumentChange(
							await nativeDocument(ctx, owner, 'current'),
							(await nativePatch(ctx, owner, 'other')).patch
						);
					} catch (error) {
						if (!(error instanceof DocumentChangeConflict)) throw error;
						incompatible = true;
					}
				}
				await ctx.runMutation(checkpoint, { ...owner, value: { kind: 'compared', incompatible } });
			} else if (b.phase === 'geometry') await uploadNativeGeometry(ctx, owner, b);
		} catch (error) {
			if (error instanceof ObsoleteNativeUnit) return null;
			const message =
				error instanceof ConvexError && typeof error.data === 'string'
					? error.data
					: error instanceof Error
						? error.message
						: 'This native operation could not complete.';
			await ctx.runMutation(fail, { ...owner, error: message.slice(0, 2000) });
		}
		return null;
	}
});
