import { fragmentKey, type InlineToken, type PaginatedPage } from '../pagination/types';
import type { DocumentSearchResult, SearchPoint, TextMatch } from './types';
import { countSearchWork } from '../runtime/render-perf';

// Use the same context-independent fold for queries and token text, including final sigma.
function foldSearchCharacter(character: string): string {
	return character.toLocaleLowerCase().replaceAll('ς', 'σ');
}

export function normalizeSearchText(value: string): string {
	return Array.from(value.trim().replace(/\s+/gu, ' '), foldSearchCharacter).join('');
}

export function findTextMatches(text: string, query: string): TextMatch[] {
	if (!query) return [];
	const matches: TextMatch[] = [];
	let start = 0;
	while (start <= text.length - query.length) {
		const matchStart = text.indexOf(query, start);
		if (matchStart === -1) break;
		matches.push({ start: matchStart, end: matchStart + query.length });
		start = matchStart + query.length;
	}
	return matches;
}

interface TextBlock {
	text: string;
	starts: SearchPoint[];
	ends: SearchPoint[];
}
interface TextPiece {
	tokens: readonly InlineToken[];
	location: Omit<SearchPoint, 'tokenIndex' | 'offset'>;
}
interface CorpusEntry {
	pieces: TextPiece[];
	block: TextBlock;
}

function appendTokens(block: TextBlock, { tokens, location }: TextPiece) {
	for (const [tokenIndex, token] of tokens.entries()) {
		let offset = 0;
		for (const character of token.value) {
			const end = offset + character.length;
			const normalized = /\s/u.test(character)
				? block.text && !block.text.endsWith(' ')
					? ' '
					: ''
				: foldSearchCharacter(character);
			for (let i = 0; i < normalized.length; i++) {
				block.text += normalized[i];
				block.starts.push({ ...location, tokenIndex, offset });
				block.ends.push({ ...location, tokenIndex, offset: end });
			}
			offset = end;
		}
	}
}

function samePiece(a: TextPiece, b: TextPiece): boolean {
	return (
		a.tokens === b.tokens &&
		a.location.pageNumber === b.location.pageNumber &&
		a.location.fragmentKey === b.location.fragmentKey &&
		a.location.row === b.location.row &&
		a.location.cell === b.location.cell
	);
}

/** Search corpus comes exclusively from committed page tokens, including repeated table headers. */
export class DocumentSearchCache {
	#pages?: readonly PaginatedPage[];
	#entries = new Map<string, CorpusEntry>();
	#query = '';
	#matches = new WeakMap<TextBlock, DocumentSearchResult[]>();

	reset() {
		this.#pages = undefined;
		this.#entries.clear();
		this.#query = '';
		this.#matches = new WeakMap();
	}

	#acceptPages(pages: readonly PaginatedPage[]) {
		const groups = new Map<string, TextPiece[]>();
		for (const page of pages) {
			for (const { fragment } of page.placements) {
				const location = { pageNumber: page.number, fragmentKey: fragmentKey(fragment) };
				if (fragment.type === 'table') {
					for (const [rowIndex, row] of fragment.rows.entries()) {
						for (const [cell, content] of row.entries()) {
							const sourceRow =
								rowIndex < fragment.headerRowCount
									? rowIndex
									: (fragment.interval?.start ?? 0) + rowIndex;
							const key = JSON.stringify([
								'cell',
								page.number,
								location.fragmentKey,
								sourceRow,
								cell
							]);
							groups.set(key, [
								{ tokens: content.tokens, location: { ...location, row: sourceRow, cell } }
							]);
						}
					}
				} else {
					const key = JSON.stringify(['flow', fragment.blockKey]);
					let pieces = groups.get(key);
					if (!pieces) groups.set(key, (pieces = []));
					pieces.push({ tokens: fragment.tokens, location });
				}
			}
		}
		const next = new Map<string, CorpusEntry>();
		for (const [key, pieces] of groups) {
			const previous = this.#entries.get(key);
			if (
				previous &&
				previous.pieces.length === pieces.length &&
				pieces.every((piece, i) => samePiece(piece, previous.pieces[i]))
			) {
				next.set(key, previous);
				continue;
			}
			const block: TextBlock = { text: '', starts: [], ends: [] };
			for (const piece of pieces) appendTokens(block, piece);
			next.set(key, { pieces, block });
		}
		this.#pages = pages;
		this.#entries = next;
	}

	search(pages: readonly PaginatedPage[], rawQuery: string): DocumentSearchResult[] {
		const query = normalizeSearchText(rawQuery);
		if (!query) {
			this.reset();
			return [];
		}
		if (pages !== this.#pages) this.#acceptPages(pages);
		if (this.#query !== query) {
			this.#query = query;
			this.#matches = new WeakMap();
		}
		return [...this.#entries.values()].flatMap(({ block }) => {
			let matches = this.#matches.get(block);
			if (!matches) {
				countSearchWork('scannedCharacters', block.text.length);
				matches = findTextMatches(block.text, query).map((match) => ({
					start: block.starts[match.start],
					end: block.ends[match.end - 1]
				}));
				this.#matches.set(block, matches);
			}
			return matches;
		});
	}
}

interface MountedSearchRange {
	range: Range;
	start: Text;
	end: Text;
	startPage: PaginatedPage;
	endPage: PaginatedPage;
}

/** Resolve only matching token locations. Search itself needs no DOM or mounted page. */
export class DocumentSearchRanges {
	#root?: HTMLElement;
	#ranges = new Map<DocumentSearchResult, MountedSearchRange>();

	reset() {
		this.#root = undefined;
		this.#ranges.clear();
	}

	materialize(
		root: HTMLElement,
		results: readonly DocumentSearchResult[],
		pages: readonly PaginatedPage[]
	): (Range | null)[] {
		if (root !== this.#root) this.reset();
		this.#root = root;
		const next = new Map<DocumentSearchResult, MountedSearchRange>();
		const tokens = new Map<string, NodeListOf<HTMLElement>>();
		const resolve = (point: SearchPoint) => {
			const key = JSON.stringify([point.pageNumber, point.fragmentKey, point.row, point.cell]);
			let leaves = tokens.get(key);
			if (!leaves) {
				const selector =
					`[data-page-number="${point.pageNumber}"] [data-source-fragment-key="${CSS.escape(point.fragmentKey)}"]` +
					(point.row === undefined
						? ''
						: ` [data-source-row="${point.row}"][data-source-cell="${point.cell}"]`);
				const owner = root.querySelector<HTMLElement>(selector);
				if (!owner) return;
				leaves = owner.querySelectorAll<HTMLElement>('[data-document-token]');
				tokens.set(key, leaves);
			}
			const node = leaves[point.tokenIndex]?.firstChild;
			return node?.nodeType === Node.TEXT_NODE && point.offset <= (node.textContent?.length ?? 0)
				? (node as Text)
				: undefined;
		};
		const ranges = results.map((result) => {
			const previous = this.#ranges.get(result);
			const startPage = pages[result.start.pageNumber - 1],
				endPage = pages[result.end.pageNumber - 1];
			if (!startPage || !endPage) return null;
			if (
				previous &&
				previous.startPage === startPage &&
				previous.endPage === endPage &&
				root.contains(previous.start) &&
				root.contains(previous.end) &&
				previous.range.startContainer === previous.start &&
				previous.range.endContainer === previous.end &&
				previous.range.startOffset === result.start.offset &&
				previous.range.endOffset === result.end.offset
			) {
				next.set(result, previous);
				return previous.range;
			}
			countSearchWork('rangeResolutions');
			const start = resolve(result.start),
				end = resolve(result.end);
			if (!start || !end) return null;
			const range = root.ownerDocument.createRange();
			countSearchWork('materializedRanges');
			range.setStart(start, result.start.offset);
			range.setEnd(end, result.end.offset);
			next.set(result, { range, start, end, startPage, endPage });
			return range;
		});
		this.#ranges = next;
		return ranges;
	}
}
