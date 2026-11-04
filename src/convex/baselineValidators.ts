import { v } from 'convex/values';
import { issue } from './baselineUploadValidators';

const common = v.object({
	companyId: v.id('company'),
	fingerprint: v.string(),
	issues: v.array(issue),
	blockCount: v.number(),
	chunkCount: v.number(),
	blocksJsonBytes: v.number(),
	chunkReadBytes: v.number()
});
const docx = common.extend({
	source: v.literal('docx'),
	originalFileId: v.id('_storage'),
	filename: v.string(),
	fileHash: v.string(),
	parserVersion: v.string(),
	uploaderId: v.id('profiles')
});
const seed = common.extend({
	source: v.literal('seed'),
	bootstrapKey: v.string(),
	publishedAt: v.number()
});

export const storedBaseline = v.union(
	docx.extend({ state: v.literal('prepared'), expiresAt: v.number() }),
	docx.extend({ state: v.literal('published'), publishedAt: v.number() }),
	docx.extend({ state: v.literal('deleting'), expiresAt: v.number() }),
	seed.extend({ state: v.literal('published') })
);
