'use node';
import { ConvexError, v, type Infer } from 'convex/values';
import { internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { preparation, paragraphDecision } from './templateUploadValidators';
import { roleAssignment } from '../lib/document/source-validators';
import { documentSource } from '../lib/document/paragraph-migration';
import { canonicalFingerprint } from './templateSourceStorage';
import { importDocx } from '../lib/server/document/import/docx';
import { DOCX_MAX_BYTES } from '../lib/document/import/limits';

/** Read-only repair proposal from the retained original; source mismatches stop here. */
export const analyzeExisting = internalAction({
	args: {
		companyId: v.id('company'),
		templateSourceId: v.id('templateSources'),
		expectedFingerprint: v.string()
	},
	returns: v.object({
		assignments: v.array(roleAssignment),
		decisions: v.array(paragraphDecision)
	}),
	handler: async (
		ctx,
		args
	): Promise<{
		assignments: Infer<typeof roleAssignment>[];
		decisions: Infer<typeof paragraphDecision>[];
	}> => {
		const existing = await ctx.runQuery(internal.templateSourceFormatting.inspectSource, {
			companyId: args.companyId,
			templateSourceId: args.templateSourceId
		});
		if (existing.fingerprint !== args.expectedFingerprint)
			throw new ConvexError('The template source changed. Review it again.');
		if (!existing.originalFileId)
			throw new ConvexError(
				'This template source has no original Word file. Supply a reviewed role map.'
			);
		const file = await ctx.storage.get(existing.originalFileId);
		if (!file || file.size > DOCX_MAX_BYTES)
			throw new ConvexError('The original Word file is unavailable. Supply a reviewed role map.');
		const parsed = importDocx(new Uint8Array(await file.arrayBuffer()));
		if (parsed.issues.some((issue) => issue.severity === 'error'))
			throw new ConvexError(
				'The original Word file could not be reanalyzed without conversion errors.'
			);
		if (canonicalFingerprint(documentSource(parsed.blocks)) !== existing.sourceFingerprint)
			throw new ConvexError(
				'The original Word file no longer maps exactly to stored source identities, text, numbering, and references. Automatic repair was stopped.'
			);
		return {
			assignments: parsed.blocks.flatMap((block) =>
				block.kind === 'paragraph' ? [{ blockKey: block.blockKey, role: block.role }] : []
			),
			decisions: parsed.decisions
		};
	}
});

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
			return {
				preparedTemplateSourceId: null,
				blockCount: parsed.blocks.length,
				issues: parsed.issues
			};
		const result = await ctx.runMutation(internal.templateUploads.prepare, {
			...args,
			blocks: parsed.blocks,
			issues: parsed.issues
		});
		return {
			preparedTemplateSourceId: result.preparedTemplateSourceId,
			blockCount: parsed.blocks.length,
			issues: parsed.issues
		};
	}
});
