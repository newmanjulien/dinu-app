import { annotationSegment } from '$lib/playbook/document-overlay';
import type { ResolvedBlock } from '$lib/contract/model';
import type { StructuralBoundary } from '$lib/contract/source-index';
import { tokenizeInline } from './tokenize';
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
function geometryTokens(tokens: readonly InlineToken[]) {
	let segment = -1;
	let previous: string | undefined;
	return tokens.map((token, index) => {
		const descriptor = annotationSegment(token.annotations);
		if (!index || previous !== descriptor.membershipKey) segment++;
		previous = descriptor.membershipKey;
		return [token.value, token.revision ?? null, segment, Boolean(descriptor.target)];
	});
}

export class LayoutPreparationEngine {
	#blocks = new WeakMap<ResolvedBlock, PreparedBlock>();
	#cells = new WeakMap<object, { readonly tokens: readonly InlineToken[] }>();
	preparedCount = 0;
	tokenCount = 0;
	begin() {
		this.preparedCount = 0;
		this.tokenCount = 0;
	}
	prepare(block: ResolvedBlock): PreparedBlock {
		const cached = this.#blocks.get(block);
		if (cached) return cached;
		this.preparedCount++;
		const tokens = (runs: Parameters<typeof tokenizeInline>[0]) => {
			const value = tokenizeInline(runs);
			this.tokenCount += value.length;
			return value;
		};
		let fragment: PageFragment;
		if (block.kind === 'table') {
			fragment = {
				type: 'table',
				interval: { start: 0, end: block.rows.length - block.headerRowCount },
				blockKey: block.blockKey,
				variant: block.variant,
				headerRowCount: block.headerRowCount,
				rows: block.rows.map((row) =>
					row.map((cell) => {
						let value = this.#cells.get(cell.content);
						if (!value) {
							value = { tokens: tokens(cell.content) };
							this.#cells.set(cell.content, value);
						}
						return value;
					})
				)
			};
		} else {
			const inline = tokens(block.content);
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
		const geometryFingerprint = JSON.stringify(
			fragment.type === 'table'
				? [
						'table',
						fragment.variant,
						fragment.headerRowCount,
						fragment.rows.map((row) => row.map((cell) => geometryTokens(cell.tokens)))
					]
				: [
						fragment.type,
						fragment.type === 'heading' ? fragment.level : null,
						geometryTokens(fragment.tokens)
					]
		);
		const prepared = {
			fragment,
			geometryFingerprint,
			...(block.kind !== 'table' && block.boundariesAfter?.length
				? { boundariesAfter: block.boundariesAfter }
				: {})
		};
		this.#blocks.set(block, prepared);
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
