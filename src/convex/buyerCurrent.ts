import type { Infer } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { CurrentContractRoot } from './contractState';
import type { TransitionWork } from './contractChanges';
import type { buyerCurrentView } from './buyerValidators';
import { buyerName } from './contractBuyer';
import { displayIdentity } from './contractDisplay';
import { documentBytes, assertStorageCapacity } from './storageCapacity';

export function linkFor(ctx: QueryCtx, contractId: Id<'savedContracts'>) {
	return ctx.db
		.query('buyerLinks')
		.withIndex('by_contractId', (q) => q.eq('contractId', contractId))
		.unique();
}
export function currentViewFor(
	root: CurrentContractRoot,
	documentFingerprint: string
): Infer<typeof buyerCurrentView> {
	return {
		documentId: root.documentId,
		documentRevision: root.documentRevision,
		documentFingerprint,
		title: root.title,
		templateVersionId: root.templateVersionId,
		buyerName: buyerName(root),
		displayIdentity: displayIdentity(root, documentFingerprint)
	};
}
export type PreparedBuyerCurrentView = {
	work: TransitionWork;
	commit: (root: CurrentContractRoot) => Promise<void>;
};
/** Complete the pointer read/size plan before the caller's first business write.
 * A staged native document supplies its server-verified sealed fingerprint; it is
 * never rehydrated as ordinary committed content before atomic adoption. */
export async function prepareBuyerCurrentView(
	ctx: MutationCtx,
	previous: CurrentContractRoot,
	next: CurrentContractRoot,
	documentFingerprint?: string
): Promise<PreparedBuyerCurrentView> {
	const empty = { work: {}, commit: async () => {} };
	if (
		previous.documentId === next.documentId &&
		previous.documentRevision === next.documentRevision &&
		previous.title === next.title &&
		previous.templateVersionId === next.templateVersionId &&
		buyerName(previous) === buyerName(next)
	)
		return empty;
	const link = await linkFor(ctx, previous._id);
	// Revocation is terminal; a retained link never reactivates itself.
	if (!link?.currentView) return empty;
	if (link.companyId !== previous.companyId) throw new Error('Invalid buyer link ownership.');
	if (!documentFingerprint) {
		const manifest = await ctx.db.get('contractDocuments', next.documentId);
		if (
			!manifest ||
			manifest.contractId !== next._id ||
			manifest.companyId !== next.companyId ||
			(manifest.stage && !manifest.stage.sealed)
		)
			throw new Error('Invalid current document manifest.');
		documentFingerprint = manifest.fingerprint;
	}
	const fingerprint = documentFingerprint;
	const view = currentViewFor(next, fingerprint);
	const bytes = documentBytes({ ...link, currentView: view });
	return {
		work: { documents: 1, bytes, queries: 1 },
		commit: async (root) => {
			if (
				root._id !== next._id ||
				root.companyId !== next.companyId ||
				root.documentRevision !== next.documentRevision ||
				root.title !== next.title ||
				root.templateVersionId !== next.templateVersionId ||
				buyerName(root) !== buyerName(next)
			)
				throw new Error('Prepared buyer pointer changed before adoption.');
			await ctx.db.patch('buyerLinks', link._id, {
				currentView: currentViewFor(root, fingerprint)
			});
		}
	};
}
/** Metadata-only callers prepare locally before writing their root/provider fields. */
export async function admitBuyerCurrentView(ctx: MutationCtx, plan: PreparedBuyerCurrentView) {
	if (plan.work.documents)
		await assertStorageCapacity(ctx, {
			documents: plan.work.documents,
			bytes: plan.work.bytes ?? 0,
			queries: plan.work.queries
		});
}
/** Same transaction as logical contract deletion, before deferred physical cleanup. */
export async function revokeBuyerCurrentView(
	ctx: MutationCtx,
	companyId: Id<'company'>,
	contractId: Id<'savedContracts'>
) {
	const link = await linkFor(ctx, contractId);
	if (link?.companyId === companyId && link.currentView)
		await ctx.db.patch('buyerLinks', link._id, { currentView: null });
}
