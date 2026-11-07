import type { BaselineBlock, SourceTable } from './source-model';

type Paragraph = Extract<BaselineBlock, { kind: 'paragraph' }>;
export type PriorBlock =
	| SourceTable
	| (Omit<Paragraph, 'kind' | 'role'> & {
			kind: 'paragraph' | 'heading';
			role?: Paragraph['role'];
			level?: number;
	  });

/** Migration boundary only. Ordinary readers accept the canonical paragraph model. */
export function normalizeParagraphBlocks(blocks: readonly PriorBlock[]): BaselineBlock[] {
	return blocks.map((block) => {
		if (block.kind === 'table') return block;
		const { level: _level, ...source } = block;
		return {
			...source,
			kind: 'paragraph',
			role: block.role ?? (block.kind === 'heading' ? 'heading' : 'body'),
			...(block.kind === 'heading' && block.numbering
				? { numbering: { ...block.numbering, continueSequence: false as const } }
				: {})
		};
	});
}

/** Compare source coordinates/content/legal addresses; omit presentation and the migrated edit policy. */
export function contractSource(blocks: readonly PriorBlock[]) {
	return blocks.map((block) => {
		if (block.kind === 'table') return block;
		const {
			kind: _kind,
			role: _role,
			level: _level,
			anchor: _anchor,
			numbering,
			...source
		} = block;
		if (!numbering) return source;
		const { continueSequence: _continuation, ...legalAddress } = numbering;
		return { ...source, numbering: legalAddress };
	});
}
