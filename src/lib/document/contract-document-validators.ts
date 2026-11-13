import { v, type Validator } from 'convex/values';
import { sourceBlock } from './source-validators';

export const originInterval = v.object({
	sourceKey: v.string(),
	start: v.number(),
	end: v.number()
});
/** Convex has no tuple validator; internal document admission checks each pair's arity. */
const aliases = v.array(v.array(v.string())) as Validator<[string, string][]>;
export const contractRenderTransport = v.object({
	blocks: v.array(sourceBlock),
	pieceGroups: v.array(
		v.array(
			v.object({
				sourceKey: v.string(),
				origin: originInterval,
				originalRangeGroups: v.optional(v.array(v.array(originInterval)))
			})
		)
	),
	aliasGroups: v.array(aliases),
	removedBlockGroups: v.array(v.array(v.string()))
});
