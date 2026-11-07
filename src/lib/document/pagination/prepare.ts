import type { ResolvedBlock } from '$lib/contract/model';
import type { StructuralBoundary } from '$lib/contract/source-index';
import { complete } from '$lib/contract/iteration';
import { contractFlowRole, ContractSpacing, type ContractFlowRole } from '$lib/contract/format';
import { iterateInlineTokens } from './tokenize';
import type { InlineToken, PageFragment, ParagraphFragment } from './types';

// Geometry authorizes height reuse only. Fragments always carry current provenance.
// Prepared object identity also guards page content and provenance reuse.
export interface PreparedBlock {
	readonly fragment: PageFragment;
	readonly flowRole: ContractFlowRole;
	readonly geometryFingerprint: string;
	/** Composition supplies the real owner; pagination never infers it from nearby output. */
	readonly boundariesAfter?: readonly StructuralBoundary[];
}

// Only in-flow text, revision and line boundaries affect geometry. Annotation owners
// are projected outside that flow after pagination and never enter these keys.
function* geometryTokens(tokens: readonly InlineToken[]): Generator<undefined, unknown[]> {
	const result: unknown[] = [];
	for (const [index, token] of tokens.entries()) {
		result.push([
			token.value,
			token.revision ?? null,
			Boolean(token.lineBreak),
			Boolean(token.lineAnchor)
		]);
		if (index % 128 === 0) yield undefined;
	}
	return result;
}

export class LayoutPreparationEngine {
	constructor(
		private readonly blocks = new WeakMap<
			ResolvedBlock,
			{
				role: ContractFlowRole;
				variants: Map<number, PreparedBlock>;
			}
		>()
	) {}
	fork() {
		return new LayoutPreparationEngine(this.blocks);
	}
	preparedCount = 0;
	tokenCount = 0;
	reusedCount = 0;
	prepare(block: ResolvedBlock, spacing = new ContractSpacing()): PreparedBlock {
		return complete(this.iterate(block, spacing));
	}
	*iterate(
		block: ResolvedBlock,
		spacing = new ContractSpacing()
	): Generator<undefined, PreparedBlock> {
		let entry = this.blocks.get(block);
		if (!entry) {
			entry = {
				role: contractFlowRole({
					kind: block.kind,
					...(block.kind !== 'table'
						? {
								role: block.role,
								content: block.content
									.filter((run) => run.generated !== 'empty-hit-target')
									.map((run) => run.text)
									.join('')
							}
						: {})
				}),
				variants: new Map()
			};
			this.blocks.set(block, entry);
		}
		const gapBefore = spacing.next(entry.role);
		const cached = entry.variants.get(gapBefore);
		if (cached) {
			this.reusedCount++;
			return cached;
		}
		this.preparedCount++;
		const engine = this;
		function* tokens(
			runs: Parameters<typeof iterateInlineTokens>[0]
		): Generator<undefined, readonly InlineToken[]> {
			const value = yield* iterateInlineTokens(runs);
			engine.tokenCount += value.length;
			return value;
		}
		let fragment: PageFragment;
		let geometry: unknown;
		if (block.kind === 'table') {
			const rows: Extract<PageFragment, { type: 'table' }>['rows'][number][] = [];
			for (const row of block.rows) {
				const cells: { readonly tokens: readonly InlineToken[] }[] = [];
				for (const cell of row) {
					const cellTokens: InlineToken[] = [{ value: cell }];
					if (/[\r\n]$/u.test(cell))
						cellTokens.push({ value: '\u200b', lineAnchor: true, generated: 'empty-hit-target' });
					cells.push({ tokens: cellTokens });
					this.tokenCount += cellTokens.length;
					yield undefined;
				}
				rows.push(cells);
			}
			fragment = {
				type: 'table',
				isFinal: true,
				interval: { start: 0, end: block.rows.length - block.headerRowCount },
				blockKey: block.blockKey,
				variant: block.variant,
				headerRowCount: block.headerRowCount,
				rows
			};
			geometry = ['table', block.variant, block.headerRowCount, block.rows];
		} else {
			const inline = yield* tokens(block.content);
			fragment = {
				type: 'paragraph',
				role: block.role,
				anchor: block.anchor ?? (block.role !== 'body' ? block.blockKey : undefined),
				interval: { start: 0, end: inline.length },
				blockKey: block.blockKey,
				tokens: inline,
				isFinal: true,
				...(block.role !== 'body' ? { keepWithNext: true } : {})
			};
			geometry = [fragment.type, fragment.role, yield* geometryTokens(fragment.tokens)];
		}
		fragment = {
			...fragment,
			gapBefore,
			...(fragment.type === 'paragraph' && entry.role === 'contact-start'
				? { keepWithNext: true }
				: {})
		};
		const geometryFingerprint = JSON.stringify([gapBefore, geometry]);
		const prepared = {
			fragment,
			flowRole: entry.role,
			geometryFingerprint,
			...(block.kind !== 'table' && block.boundariesAfter?.length
				? { boundariesAfter: block.boundariesAfter }
				: {})
		};
		entry.variants.set(gapBefore, prepared);
		return prepared;
	}
}

export function paragraphSlice(
	block: ParagraphFragment,
	start: number,
	end: number
): ParagraphFragment {
	if (start === 0 && end === block.tokens.length) return block;
	return {
		...block,
		interval: { start, end },
		tokens: block.tokens.slice(start, end),
		isFinal: end === block.tokens.length
	};
}
