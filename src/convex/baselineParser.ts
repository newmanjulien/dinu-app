'use node';
import { v, type Infer } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { preparation } from './baselineUploadValidators';
import { importDocx } from '../lib/server/contract/import/docx';
import { DOCX_MAX_BYTES } from '../lib/contract/import/limits';

export const prepare = internalAction({
	args: {
		membershipId: v.id('memberships'),
		originalFileId: v.id('_storage'),
		filename: v.string(),
		fileHash: v.string()
	},
	returns: v.union(preparation, v.object({ error: v.string() })),
	handler: async (ctx, args): Promise<Infer<typeof preparation> | { error: string }> => {
		const file = await ctx.storage.get(args.originalFileId);
		if (!file || file.size > DOCX_MAX_BYTES)
			return { error: 'The uploaded Word file is unavailable. Select it again.' };
		let parsed: ReturnType<typeof importDocx>;
		try {
			parsed = importDocx(new Uint8Array(await file.arrayBuffer()));
		} catch (error) {
			return {
				error:
					error instanceof Error
						? error.message
						: 'Unable to read this Word file. Save it again in Word and re-upload.'
			};
		}
		if (parsed.issues.some((issue) => issue.severity === 'error'))
			return { preparedBaselineId: null, blockCount: parsed.blocks.length, issues: parsed.issues };
		const result = await ctx.runMutation(internal.baselineUploads.prepare, { ...args, ...parsed });
		return {
			preparedBaselineId: result.preparedBaselineId,
			blockCount: parsed.blocks.length,
			issues: parsed.issues
		};
	}
});
