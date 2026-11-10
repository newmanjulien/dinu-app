import { v } from 'convex/values';
import { sourceBlock } from '../lib/document/source-validators';
import { historicalItem } from './playbookValidators';

export const templateContent = v.object({
	blockCount: v.number(),
	itemCount: v.number(),
	blocks: v.array(sourceBlock),
	items: v.array(historicalItem)
});
