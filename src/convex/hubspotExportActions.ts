'use node';
import { ConvexError, v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { exportRequest } from './savedContractValidators';
import { generateWord } from '../lib/server/contract/export/word';
import { composeExport } from '../lib/contract/export/content';
import { concessionSelections } from '../lib/contract/applications';
import { toDocumentOverlay } from '../lib/playbook/document-overlay';
import { createHash } from 'node:crypto';
export const generate = internalAction({
	args: exportRequest.extend({ operationId: v.string() }).fields,
	returns: v.object({ url: v.string(), filename: v.string(), attemptId: v.id('hubspotExports') }),
	handler: async (
		ctx,
		args
	): Promise<{
		url: string;
		filename: string;
		attemptId: import('./_generated/dataModel').Id<'hubspotExports'>;
	}> => {
		const claim = crypto.randomUUID();
		const attempt = await ctx.runMutation(internal.hubspotExports.reserve, { ...args, claim });
		if (attempt.state === 'preparing') {
			if (attempt.claim !== claim)
				throw new ConvexError('This download is still being prepared. Try again shortly.');
			const content = await ctx.runQuery(internal.hubspotExports.content, {
				id: attempt._id,
				claim
			});
			const blob = await generateWord(
				composeExport({
					blocks: content.blocks,
					items: content.items.map(toDocumentOverlay),
					activeConcessions: concessionSelections(content.applications)
				}),
				content.title
			);
			const bytes = await blob.arrayBuffer(),
				fileId = await ctx.storage.store(blob);
			try {
				await ctx.runMutation(internal.hubspotExports.publish, {
					id: attempt._id,
					claim,
					fileId,
					size: bytes.byteLength,
					sha256: createHash('sha256').update(new Uint8Array(bytes)).digest('hex')
				});
			} catch (error) {
				await ctx.runMutation(internal.storageOwnership.discardFile, { fileId });
				throw error;
			}
		}
		return ctx.runMutation(internal.hubspotExports.release, { id: attempt._id });
	}
});
