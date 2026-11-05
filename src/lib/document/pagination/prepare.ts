import { annotationSegment } from '$lib/playbook/document-overlay';
import type { ResolvedBlock } from '$lib/contract/model';
import type { StructuralBoundary } from '$lib/contract/source-index';
import { complete } from '$lib/contract/iteration';
import { iterateInlineTokens } from './tokenize';
import type { InlineToken, PageFragment, ParagraphFragment } from './types';

// Geometry authorizes height reuse only. Fragments always carry current provenance.
// Prepared object identity also guards page content and provenance reuse.
export interface PreparedBlock {
	readonly fragment: PageFragment;
	readonly geometryFingerprint: string;
	/** Composition supplies the real owner; pagination never infers it from nearby output. */
	readonly boundariesAfter?: readonly StructuralBoundary[];
}

// Preserve token/span and revision boundaries. Occurrence names and source coordinates
// are provenance only, but Annotation segmentation is layout (especially in tables).
function* geometryTokens(tokens: readonly InlineToken[]): Generator<undefined, unknown[]> {
	const result: unknown[] = [];
	let segment = -1;
	let previous: string | undefined;
	for (const [index, token] of tokens.entries()) {
		const descriptor = annotationSegment(token.annotations);
		if (!index || previous !== descriptor.membershipKey) segment++;
		previous = descriptor.membershipKey;
		result.push([token.value, token.revision ?? null, segment, Boolean(descriptor.target)]);
		if (index % 128 === 0) yield undefined;
	}
	return result;
}

export class LayoutPreparationEngine {
	constructor(
		private readonly blocks = new WeakMap<ResolvedBlock, PreparedBlock>(),
		private readonly cells = new WeakMap<object, { readonly tokens: readonly InlineToken[] }>()
	) {}
	fork() {
		return new LayoutPreparationEngine(this.blocks, this.cells);
	}
	preparedCount = 0;
	tokenCount = 0;
	reusedCount = 0;
	prepare(block: ResolvedBlock): PreparedBlock {
		return complete(this.iterate(block));
	}
	*iterate(block: ResolvedBlock): Generator<undefined, PreparedBlock> {
		const cached = this.blocks.get(block);
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
		if (block.kind === 'table') {
			const rows: Extract<PageFragment, { type: 'table' }>['rows'][number][] = [];
			for (const row of block.rows) {
				const cells: { readonly tokens: readonly InlineToken[] }[] = [];
				for (const cell of row) {
					let value = this.cells.get(cell.content);
					if (!value) {
						value = { tokens: yield* tokens(cell.content) };
						this.cells.set(cell.content, value);
					}
					cells.push(value);
					yield undefined;
				}
				rows.push(cells);
			}
			fragment = {
				type: 'table',
				interval: { start: 0, end: block.rows.length - block.headerRowCount },
				blockKey: block.blockKey,
				variant: block.variant,
				headerRowCount: block.headerRowCount,
				rows
			};
		} else {
			const inline = yield* tokens(block.content);
			fragment =
				block.kind === 'heading'
					? {
							type: 'heading',
							interval: { start: 0, end: inline.length },
							blockKey: block.blockKey,
							anchor: block.anchor,
							level: block.level,
							tokens: inline
						}
					: {
							type: 'paragraph',
							interval: { start: 0, end: inline.length },
							blockKey: block.blockKey,
							tokens: inline,
							isContinuation: false,
							isFinal: true
						};
		}
		let geometry: unknown;
		if (fragment.type === 'table') {
			const rows: unknown[][] = [];
			for (const row of fragment.rows) {
				const cells: unknown[] = [];
				for (const cell of row) cells.push(yield* geometryTokens(cell.tokens));
				rows.push(cells);
			}
			geometry = ['table', fragment.variant, fragment.headerRowCount, rows];
		} else
			geometry = [
				fragment.type,
				fragment.type === 'heading' ? fragment.level : null,
				yield* geometryTokens(fragment.tokens)
			];
		const geometryFingerprint = JSON.stringify(geometry);
		const prepared = {
			fragment,
			geometryFingerprint,
			...(block.kind !== 'table' && block.boundariesAfter?.length
				? { boundariesAfter: block.boundariesAfter }
				: {})
		};
		this.blocks.set(block, prepared);
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
		isContinuation: start > 0,
		isFinal: end === block.tokens.length
	};
}
