'use node';

import { v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { exportRequest } from './savedContractValidators';
import { composeExport, contractName } from '../lib/contract/export/content';
import { generateWord } from '../lib/server/contract/export/word';
import { toDocumentOverlay } from '../lib/playbook/document-overlay';

/** Generate only on request. Temporary files are retired even if the browser leaves. */
export const generate = action({
	args: exportRequest.fields,
	returns: v.object({ url: v.string(), filename: v.string() }),
	handler: async (ctx, args): Promise<{ url: string; filename: string }> => {
		const { contract, snapshot, requiredReviews } = await ctx.runQuery(
			internal.contractExports.source,
			args
		);
		const blob = await generateWord(
			composeExport({
				blocks: snapshot.blocks,
				items: snapshot.items.map(toDocumentOverlay),
				activeConcessions: contract.selectedConcessions
			}),
			contract.companyName
		);
		const fileId = await ctx.storage.store(blob);
		try {
			const url = await ctx.runMutation(internal.contractExports.finalize, {
				...args,
				templateVersionId: contract.templateVersionId,
				requiredReviews,
				fileId
			});
			const timestamp = new Date()
				.toISOString()
				.slice(0, 19)
				.replace('T', ' ')
				.replaceAll(':', '-');
			return { url, filename: `${contractName(contract.companyName)} - ${timestamp}.docx` };
		} catch (error) {
			try {
				await ctx.storage.delete(fileId);
			} catch (cleanupError) {
				console.error('Unable to delete failed contract export.', cleanupError);
			}
			throw error;
		}
	}
});
