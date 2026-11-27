'use node';
import { createHash } from 'node:crypto';
import { ConvexError, type Infer } from 'convex/values';
import type { ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import { contractName } from '../lib/contract/filename';
import { composeExport } from '../lib/document/export/content';
import { toAppliedOverlayItems } from '../lib/playbook/document-overlay';
import { generateWord } from '../lib/server/document/export/word';
import { wordExportRequest } from './exportValidators';
import { wordExportResult } from './savedContractValidators';

export async function generateWordExport(
	ctx: ActionCtx,
	args: Infer<typeof wordExportRequest>
): Promise<Infer<typeof wordExportResult>> {
	const prepared = await ctx.runQuery(internal.contractExports.prepare, args);
	if (prepared.kind === 'existing') {
		if (prepared.downloadExpiresAt <= Date.now())
			throw new ConvexError('This download attempt expired. Start a new download.');
		return { url: prepared.url, filename: prepared.filename };
	}

	const items = toAppliedOverlayItems(prepared.appliedOverlays);
	const blob = await generateWord(
		composeExport({
			blocks: prepared.blocks,
			items,
			concessions: prepared.concessions
		}),
		contractName(prepared.title)
	);
	const bytes = await blob.arrayBuffer();
	const fileId = await ctx.storage.store(blob);
	try {
		return await ctx.runMutation(internal.contractExports.commit, {
			...args,
			fileId,
			size: bytes.byteLength,
			sha256: createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),
			expectedTemplateVersionId: prepared.templateVersionId,
			expectedStateRevision: prepared.stateRevision,
			expectedTitle: prepared.title
		});
	} catch (error) {
		await ctx.runMutation(internal.storageOwnership.discardFile, { fileId });
		throw error;
	}
}
