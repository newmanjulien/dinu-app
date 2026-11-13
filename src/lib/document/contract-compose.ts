import { DocumentCompositionEngine, type CompositionInput } from './compose';
import { canonicalJson } from './canonical-json';
import type { CompositionArtifactStore, CompositionRequest } from './composition-artifacts';
import type { ContractDocument, PieceLineage } from './contract-document';
import type { ResolvedBlock, ResolvedRun, SourceBlock } from './model';
import type { SourceIndex } from './source-index';
import { iterateRedlineDiff, iterateRedlineTextTokens, type RedlineToken } from './redline-diff';

type Paragraph = Extract<ResolvedBlock, { kind: 'paragraph' }>;
type Token = RedlineToken & { runs?: ResolvedRun[]; paragraph: Paragraph };

function sliceRun(run: ResolvedRun, from: number, to: number): ResolvedRun {
	const range = (source: NonNullable<ResolvedRun['source']>) => ({
		start: { ...source.start, offset: source.start.offset + from },
		end: { ...source.end, offset: source.start.offset + to }
	});
	return {
		...run,
		text: run.text.slice(from, to),
		...(run.source && run.sourceKind === 'text' ? { source: range(run.source) } : {}),
		...(run.sourceOrigin && run.sourceKind === 'text'
			? { sourceOrigin: range(run.sourceOrigin) }
			: {}),
		...(run.discussion
			? { discussion: { ...run.discussion, offset: run.discussion.offset + from } }
			: {}),
		...(run.generatedOffset !== undefined ? { generatedOffset: run.generatedOffset + from } : {})
	};
}

function* tokens(
	blocks: readonly Paragraph[],
	atoms: ReadonlyMap<string, string>
): Generator<undefined, Token[]> {
	const result: Token[] = [];
	for (const paragraph of blocks) {
		let textRuns: ResolvedRun[] = [];
		function* flush(): Generator<undefined> {
			const text = textRuns.map((run) => run.text).join('');
			let runIndex = 0,
				runStart = 0,
				tokenStart = 0;
			for (const token of yield* iterateRedlineTextTokens(text)) {
				const tokenEnd = tokenStart + token.text.length,
					runs: ResolvedRun[] = [];
				while (runIndex < textRuns.length && runStart < tokenEnd) {
					const run = textRuns[runIndex],
						end = runStart + run.text.length;
					if (end > tokenStart)
						runs.push(
							sliceRun(
								run,
								Math.max(0, tokenStart - runStart),
								Math.min(run.text.length, tokenEnd - runStart)
							)
						);
					if (end > tokenEnd) break;
					runStart = end;
					runIndex++;
				}
				result.push({ ...token, runs, paragraph });
				tokenStart = tokenEnd;
			}
			textRuns = [];
		}
		for (const run of paragraph.content) {
			if (run.sourceKind === 'number' || run.sourceKind === 'reference') {
				yield* flush();
				result.push({
					key:
						run.sourceKind === 'number'
							? `number:${paragraph.blockKey}`
							: (atoms.get(run.source?.start.sourceKey ?? '') ?? `reference:${run.text}`),
					text: run.text,
					runs: [run],
					paragraph
				});
			} else {
				textRuns.push(run);
			}
			yield undefined;
		}
		yield* flush();
		result.push({ key: 'paragraph-break', text: '\n', paragraph });
	}
	return result;
}

const referenceKeys = (blocks: readonly SourceBlock[]) =>
	new Map(
		blocks.flatMap((block) =>
			block.kind === 'table'
				? []
				: block.content.flatMap((atom) =>
						atom.kind === 'reference'
							? [
									[
										atom.sourceKey,
										canonicalJson(
											Object.fromEntries(
												Object.entries(atom).filter(([key]) => key !== 'sourceKey')
											)
										)
									] as const
								]
							: []
					)
		)
	);

/** Actual wording is the input. Selections mark annotations; they never reconstruct wording. */
export class ContractDocumentCompositionEngine extends DocumentCompositionEngine {
	private readonly pieces: ReadonlyMap<string, PieceLineage>;
	private baselineResolved?: readonly ResolvedBlock[];
	private readonly resolved = new WeakMap<ResolvedBlock, ResolvedBlock>();
	private readonly suppressed = new WeakMap<CompositionInput['items'], CompositionInput['items']>();
	constructor(
		private readonly document: ContractDocument,
		private readonly baseline: readonly SourceBlock[],
		index: SourceIndex,
		artifacts?: CompositionArtifactStore
	) {
		super(document.blocks, index, artifacts, new Map(document.aliases));
		this.pieces = new Map(document.pieces.map((piece) => [piece.sourceKey, piece]));
	}
	private provenance(block: ResolvedBlock): ResolvedBlock {
		if (block.kind === 'table') return block;
		const cached = this.resolved.get(block);
		if (cached) return cached;
		const result: ResolvedBlock = {
			...block,
			content: block.content.map((run) => {
				const piece = run.source && this.pieces.get(run.source.start.sourceKey);
				if (!piece || !run.source) return run;
				return {
					...run,
					sourceOrigin: {
						start: {
							sourceKey: piece.origin.sourceKey,
							offset: piece.origin.start + run.source.start.offset
						},
						end: {
							sourceKey: piece.origin.sourceKey,
							offset: piece.origin.start + run.source.end.offset
						}
					}
				};
			})
		};
		this.resolved.set(block, result);
		return result;
	}
	*iterate(
		input: CompositionInput,
		working?: CompositionRequest
	): Generator<ResolvedBlock | undefined, void> {
		let items = this.suppressed.get(input.items);
		if (!items) {
			items = input.items.map((item) => ({
				...item,
				concessions: item.concessions.map((choice) => ({
					...choice,
					changes: choice.changes.map((change) => ({ ...change, suppressed: true }))
				}))
			}));
			this.suppressed.set(input.items, items);
		}
		const current: ResolvedBlock[] = [];
		for (const block of super.iterate({ ...input, items, view: 'effective' }, working)) {
			if (!block) {
				yield undefined;
				continue;
			}
			const resolved = this.provenance(block);
			if (input.view === 'effective') yield resolved;
			else current.push(resolved);
		}
		if (input.view === 'effective') return;
		const original = yield* this.original();
		yield* this.redline(original, current);
	}
	private *original(): Generator<undefined, readonly ResolvedBlock[]> {
		if (this.baselineResolved) return this.baselineResolved;
		const original: ResolvedBlock[] = [];
		for (const block of new DocumentCompositionEngine(this.baseline).iterate({
			items: [],
			activeConcessions: {},
			view: 'effective'
		})) {
			if (block) original.push(block);
			yield undefined;
			// A concurrent iteration may have completed while this one yielded.
			if (this.baselineResolved) return this.baselineResolved;
		}
		// Iterator-local work is discarded on cancellation; only completed output is retained.
		this.baselineResolved = original;
		return original;
	}
	private *redline(
		original: readonly ResolvedBlock[],
		current: ResolvedBlock[]
	): Generator<ResolvedBlock | undefined> {
		// Origins connect split/merged paragraphs. Matching is bounded within those groups,
		// so repeated wording elsewhere cannot become an alignment anchor.
		const parent = new Map<string, string>();
		const root = (key: string): string => {
			let next = parent.get(key);
			if (!next) {
				parent.set(key, key);
				return key;
			}
			while (next !== parent.get(next)) next = parent.get(next)!;
			parent.set(key, next);
			return next;
		};
		const join = (a: string, b: string) => parent.set(root(a), root(b));
		const baselineBySource = new Map(
			this.baseline.flatMap((block) =>
				block.kind === 'table'
					? []
					: block.content.map((atom) => [atom.sourceKey, block.blockKey] as const)
			)
		);
		for (const block of original) root(block.blockKey);
		for (const [from, to] of this.document.aliases) join(from, to);
		for (const block of this.document.blocks) {
			root(block.blockKey);
			if (block.kind !== 'table')
				for (const atom of block.content) {
					const piece = this.pieces.get(atom.sourceKey);
					for (const interval of piece
						? (piece.originalRanges ?? [piece.origin, ...piece.ancestors])
						: []) {
						const owner = baselineBySource.get(interval.sourceKey);
						if (owner) join(block.blockKey, owner);
					}
				}
			yield undefined;
		}
		const groups = new Map<string, { original: ResolvedBlock[]; current: ResolvedBlock[] }>();
		const group = (key: string) => {
			const id = root(key),
				existing = groups.get(id);
			if (existing) return existing;
			const value = { original: [], current: [] };
			groups.set(id, value);
			return value;
		};
		for (const block of original) group(block.blockKey).original.push(block);
		for (const block of current) group(block.blockKey).current.push(block);
		const sequence: string[] = [],
			seen = new Set<string>();
		let originalCursor = 0;
		const originalOrder = original.map((block) => root(block.blockKey));
		for (const block of current) {
			const key = root(block.blockKey);
			const position = originalOrder.indexOf(key, originalCursor);
			if (position >= 0)
				while (originalCursor < position) {
					const missing = originalOrder[originalCursor++];
					if (!seen.has(missing) && !groups.get(missing)!.current.length) {
						sequence.push(missing);
						seen.add(missing);
					}
				}
			if (!seen.has(key)) {
				sequence.push(key);
				seen.add(key);
			}
		}
		for (const key of originalOrder)
			if (!seen.has(key)) {
				sequence.push(key);
				seen.add(key);
			}
		const originalAtoms = referenceKeys(this.baseline),
			currentAtoms = referenceKeys(this.document.blocks);
		for (const key of sequence) {
			const value = groups.get(key)!;
			if (value.current[0]?.kind === 'table') {
				yield value.current[0];
				continue;
			}
			const before = value.original.filter(
				(block): block is Paragraph => block.kind === 'paragraph'
			);
			const after = value.current.filter((block): block is Paragraph => block.kind === 'paragraph');
			if (!before.length) {
				for (const block of after)
					yield { ...block, content: block.content.map((run) => ({ ...run, revision: 'added' })) };
				continue;
			}
			if (!after.length) {
				for (const block of before)
					yield {
						...block,
						discussionRemoved: true,
						content: block.content.map((run) => ({ ...run, revision: 'removed' }))
					};
				continue;
			}
			const a = yield* tokens(before, originalAtoms),
				b = yield* tokens(after, currentAtoms);
			const parts = (yield* iterateRedlineDiff(a, b)) ?? [
				{
					kind: 'delete' as const,
					sourceStart: 0,
					sourceEnd: a.length,
					replacementStart: 0,
					replacementEnd: 0
				},
				{
					kind: 'insert' as const,
					sourceStart: a.length,
					sourceEnd: a.length,
					replacementStart: 0,
					replacementEnd: b.length
				}
			];
			let paragraph = after[0],
				content: ResolvedRun[] = [];
			const emitted = new Set<string>();
			const output = (): Paragraph => {
				const blockKey = emitted.has(paragraph.blockKey)
					? `redline:${paragraph.blockKey}:${emitted.size}`
					: paragraph.blockKey;
				emitted.add(blockKey);
				return { ...paragraph, blockKey, content };
			};
			for (const part of parts) {
				const deletion = part.kind === 'delete';
				const selected = deletion
					? a.slice(part.sourceStart, part.sourceEnd)
					: b.slice(part.replacementStart, part.replacementEnd);
				for (const token of selected) {
					if (!token.runs) {
						if (deletion) continue;
						yield output();
						content = [];
						paragraph = after[after.indexOf(token.paragraph) + 1] ?? paragraph;
					} else {
						for (const run of token.runs) {
							const previous = content.at(-1);
							if (
								previous?.revision === 'removed' &&
								part.kind === 'insert' &&
								/[\p{L}\p{N}\p{M}\p{S}]$/u.test(previous.text) &&
								/^[\p{L}\p{N}\p{M}\p{S}]/u.test(run.text)
							)
								content.push({ text: ' ', generated: 'separator' });
							content.push({
								...run,
								...(deletion
									? { revision: 'removed' as const }
									: part.kind === 'insert'
										? { revision: 'added' as const }
										: {})
							});
						}
					}
					yield undefined;
				}
			}
			if (content.length) yield output();
		}
	}
}
