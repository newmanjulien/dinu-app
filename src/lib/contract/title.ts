import type { BaselineBlock } from './source-model';

export interface TitleHint {
	titleStyle?: boolean;
	centered?: boolean;
	openingHeading?: boolean;
	canonicalRole?: import('./source-model').ParagraphRole;
}

const sectionLabel =
	/^(?:recitals|preamble|definitions|background|terms and conditions|scope of (?:work|services))\s*[:.]?$/i;
const proseStart =
	/^(?:this\s|whereas\b|now[\s,]+therefore\b|the parties\b|in consideration\b|by and between\b)/i;
const contractName =
	/\b(?:agreement|contract|statement of work|memorandum of understanding|letter of intent|terms of (?:service|engagement))\b/i;

/** Shared prose evidence; formatting hints do not override an actual clause sentence. */
export function continuesAsProse(text: string): boolean {
	return (
		/\b(?:shall|must|will|may|agrees?|acknowledges?|means|is|are|was|were|has|have)\b/iu.test(
			text
		) ||
		/[.:]\s+(?:this|the|each|either|any|all|in|for|customer|provider|fees|services|subject|upon|if|except|such|no)\b/iu.test(
			text
		) ||
		/[.!?]\s+\p{L}/u.test(text)
	);
}

/** Assign metadata without changing source identities or interpreting the title's wording. */
export function assignTitle(
	blocks: readonly BaselineBlock[],
	blockKeys: readonly string[]
): BaselineBlock[] {
	if (
		blockKeys.length > blocks.length ||
		blockKeys.some((key, index) => {
			const block = blocks[index];
			return block.blockKey !== key || block.kind === 'table' || Boolean(block.numbering);
		})
	)
		throw new Error('The contract title must be an unnumbered opening group.');
	return blocks.map((block, index) => {
		if (block.kind === 'table') return block;
		return {
			...block,
			role: index < blockKeys.length ? 'title' : block.role === 'title' ? 'body' : block.role
		};
	});
}

/** Classify only the opening label sequence, before source identities are published.
 * Word's Title/Subtitle styles and alignment are hints, never retained formatting.
 */
export function identifyTitle(
	blocks: readonly BaselineBlock[],
	hints: ReadonlyMap<string, TitleHint> = new Map()
): BaselineBlock[] {
	const explicit = blocks.filter((block) => block.kind !== 'table' && block.role === 'title');
	if (explicit.length)
		return assignTitle(
			blocks,
			explicit.map((block) => block.blockKey)
		);
	let end = 0;
	let recognized = false;
	for (const block of blocks) {
		if (block.kind === 'table' || block.numbering) break;
		const text = block.content
			.map((atom) => (atom.kind === 'text' ? atom.text : ''))
			.join('')
			.trim();
		const hint = hints.get(block.blockKey);
		if (hint?.canonicalRole && hint.canonicalRole !== 'title') break;
		const explicitTitle = block.role === 'title' || hint?.titleStyle;
		const openingHeading: boolean = !recognized && Boolean(hint?.openingHeading);
		const label = text === text.toUpperCase() && /\p{L}/u.test(text);
		if (text) {
			if (hint?.canonicalRole !== 'title' && continuesAsProse(text)) break;
			if (
				!explicitTitle &&
				(sectionLabel.test(text) || /^\s*(?:\d+[.)]|\([a-z0-9]+\))\s/i.test(text))
			)
				break;
			if (
				!explicitTitle &&
				((proseStart.test(text) && !(label && contractName.test(text))) ||
					(!openingHeading &&
						!hint?.centered &&
						(text.length > 180 || text.split(/\s+/).length > 24)) ||
					/[!?;]/.test(text))
			)
				break;
			const evidence: boolean =
				Boolean(explicitTitle || hint?.centered) || openingHeading || contractName.test(text);
			// Short body sentences must not join an already recognized title.
			if (recognized && !evidence && !label) break;
			recognized ||= evidence;
		}
		end++;
	}
	return assignTitle(blocks, recognized ? blocks.slice(0, end).map((block) => block.blockKey) : []);
}
