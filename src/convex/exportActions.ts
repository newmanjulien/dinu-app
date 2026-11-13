'use node';
import { ConvexError, v } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { exportRequest } from './savedContractValidators';
import { contractName } from '../lib/contract/filename';
import { generateWord } from '../lib/server/document/export/word';
import { composeExport } from '../lib/document/export/content';
import { contractDocumentFromRenderTransport } from '../lib/document/contract-document';
import { createHash } from 'node:crypto';
import { outputProgress, outputVerify } from './outputReferences';
export const generate = internalAction({
	args: exportRequest.extend({ operationId: v.string(), claim: v.optional(v.string()) }).fields,
	returns: v.object({ url: v.string(), filename: v.string(), attemptId: v.id('hubspotExports') }),
	handler: async (
		ctx,
		args
	): Promise<{
		url: string;
		filename: string;
		attemptId: import('./_generated/dataModel').Id<'hubspotExports'>;
	}> => {
		const claim = args.claim ?? crypto.randomUUID();
		let reservation = await ctx.runMutation(internal.contractExports.reserve, { ...args, claim });
		if (reservation.status === 'preparing') {
			for (let turn = 0; turn < 24; turn++)
				if (await ctx.runMutation(outputProgress, { receiptId: reservation.receiptId })) break;
			reservation = await ctx.runMutation(internal.contractExports.reserve, { ...args, claim });
		}
		if (reservation.status === 'preparing')
			throw new ConvexError({ code: 'OUTPUT_PENDING', message: 'Preparing your Word download…' });
		const attempt = reservation.attempt;
		let verified = false;
		for (let turn = 0; turn < 64 && !verified; turn++)
			verified = await ctx.runMutation(outputVerify, { receiptId: attempt.reservationReceiptId });
		if (!verified)
			throw new ConvexError({ code: 'OUTPUT_PENDING', message: 'Checking your Word download…' });
		if (attempt.state === 'preparing') {
			if (attempt.claim !== claim)
				throw new ConvexError({ code: 'OUTPUT_PENDING', message: 'Preparing your Word download…' });
			const content = await ctx.runQuery(internal.contractExports.content, {
				id: attempt._id,
				claim
			});
			const blob = await generateWord(
				composeExport({
					document: contractDocumentFromRenderTransport(content.document)
				}),
				contractName(content.title)
			);
			const bytes = await blob.arrayBuffer(),
				fileId = await ctx.storage.store(blob);
			try {
				await ctx.runMutation(internal.contractExports.publish, {
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
		let release = await ctx.runMutation(internal.contractExports.prepareRelease, {
			id: attempt._id
		});
		if (!release.complete) {
			for (let turn = 0; turn < 24; turn++)
				if (await ctx.runMutation(outputProgress, { receiptId: release.receiptId })) break;
			release = await ctx.runMutation(internal.contractExports.prepareRelease, { id: attempt._id });
		}
		if (!release.complete)
			throw new ConvexError({ code: 'OUTPUT_PENDING', message: 'Checking your Word download…' });
		return ctx.runMutation(internal.contractExports.release, { id: attempt._id });
	}
});
