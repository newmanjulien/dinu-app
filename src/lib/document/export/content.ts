import { DocumentCompositionEngine } from '../compose';
import type { CanonicalNumbering } from './numbering';
import type { SourceBlock, ResolvedRun } from '../model';
import { documentIndex, type ContractDocument } from '../contract-document';

export type ExportBlock =
	| {
			kind: 'paragraph';
			role: import('../source-model').ParagraphRole;
			numbering?: CanonicalNumbering;
			numberingDepth?: number;
			continueNumbering?: false;
			content: string;
	  }
	| {
			kind: 'table';
			variant?: 'signature';
			headerRowCount: number;
			rows: string[][];
	  };

function exportText(runs: ResolvedRun[]): string {
	let text = '';
	for (const run of runs) if (run.generated !== 'empty-hit-target') text += run.text;
	// A CRLF pair may span adjacent composition fragments.
	return text.replace(/\r\n|\r/g, '\n');
}

/** Export materialized wording, or plain template blocks for source tooling. */
export function composeExport(
	input: { blocks: readonly SourceBlock[] } | { document: ContractDocument }
): ExportBlock[] {
	const engine =
		'document' in input
			? new DocumentCompositionEngine(
					input.document.blocks,
					documentIndex(input.document),
					undefined,
					new Map(input.document.aliases)
				)
			: new DocumentCompositionEngine(input.blocks);
	const resolved = [...engine.compose({ items: [], activeConcessions: {}, view: 'effective' })];
	const numbered = new Map(
		engine.numberingBlocks.flatMap((block) =>
			block.numbering
				? [[block.blockKey, engine.addresses.get(block.numbering.itemKey)!] as const]
				: []
		)
	);
	const items = new Map(
		[...numbered.values()].map((address, index) => [
			address.numbering.itemKey,
			`DinuClause${index + 1}`
		])
	);
	const sequences = new Map<string, string>();
	return resolved.flatMap((block): ExportBlock[] => {
		if (block.kind === 'table')
			return [
				{
					kind: 'table',
					variant: block.variant,
					headerRowCount: block.headerRowCount,
					rows: block.rows.map((row) => row.map((cell) => cell.replace(/\r\n?/gu, '\n')))
				}
			];
		const content = exportText(block.content);
		// Interaction placeholders are not logical source blocks in the exported document.
		if (block.content.length && block.content.every((run) => run.generated === 'empty-hit-target'))
			return [];
		const address = numbered.get(block.blockKey);
		let numbering: CanonicalNumbering | undefined;
		if (address) {
			const item = address.numbering;
			if (!sequences.has(item.sequenceKey))
				sequences.set(item.sequenceKey, `sequence-${sequences.size + 1}`);
			numbering = {
				...item,
				itemKey: items.get(item.itemKey)!,
				sequenceKey: sequences.get(item.sequenceKey)!,
				...(item.parentItemKey ? { parentItemKey: items.get(item.parentItemKey)! } : {}),
				position: address.position
			};
		}
		return [
			{
				kind: 'paragraph' as const,
				...(numbering ? { numbering } : {}),
				role: block.role,
				...(block.numberingDepth ? { numberingDepth: block.numberingDepth } : {}),
				...(block.continueNumbering === false ? { continueNumbering: false as const } : {}),
				content
			}
		];
	});
}
