import type { ReplacementAtom } from './source-model';
import { referenceText, type Address } from './numbering';
import { normalizeReferenceAddress, type ReferenceCatalog } from './reference-catalog';

type Reference = Extract<ReplacementAtom, { kind: 'reference' }>;
type Candidate = { targetItemKey: string; address: Address; bareAlphabetic: boolean };
type AddressNode = { children: Map<string, AddressNode>; candidate?: Candidate | null };
type Match = { candidate: Candidate; start: number; end: number };

export type RecognizedReference = { start: number; end: number; reference: Reference };
export type ReferenceRecognition = {
	atoms: ReplacementAtom[];
	references: RecognizedReference[];
};
export type ReferenceRecognizer = (text: string) => ReferenceRecognition;

const wordCharacter = /[\p{L}\p{M}\p{N}\p{Pc}]/u;
const rangeSeparator = /^[ \t]*[-–—][ \t]*/u;
const referenceIntroducer = /(?:section|clause|article|paragraph|schedule)\s+$/iu;

function nextCharacter(value: string, index: number) {
	const codePoint = value.codePointAt(index);
	if (codePoint === undefined) return;
	const character = String.fromCodePoint(codePoint);
	return { character, end: index + character.length };
}

function previousCharacter(value: string, index: number) {
	if (!index) return;
	let start = index - 1;
	const code = value.charCodeAt(start);
	if (code >= 0xdc00 && code <= 0xdfff && start > 0) {
		const lead = value.charCodeAt(start - 1);
		if (lead >= 0xd800 && lead <= 0xdbff) start--;
	}
	return String.fromCodePoint(value.codePointAt(start)!);
}

function hasWordCharacter(value: string | undefined) {
	return Boolean(value && wordCharacter.test(value));
}

function hasCompleteBoundaries(text: string, start: number, end: number) {
	if (
		hasWordCharacter(previousCharacter(text, start)) ||
		hasWordCharacter(nextCharacter(text, end)?.character)
	)
		return false;
	// A period can end a sentence, but never split an address-like numeric continuation.
	return !(text[end] === '.' && /\d/u.test(nextCharacter(text, end + 1)?.character ?? ''));
}

function cloneReference(candidate: Candidate): Reference {
	return {
		kind: 'reference',
		targetItemKey: candidate.targetItemKey,
		display: { start: candidate.address.pattern.map((part) => ({ ...part })) }
	};
}

function cloneRangeReference(first: Candidate, last: Candidate, separator: string): Reference {
	return {
		kind: 'reference',
		targetItemKey: first.targetItemKey,
		endTargetItemKey: last.targetItemKey,
		display: {
			start: first.address.pattern.map((part) => ({ ...part })),
			end: last.address.pattern.map((part) => ({ ...part })),
			separator
		}
	};
}

function appendText(atoms: ReplacementAtom[], text: string) {
	if (!text) return;
	const previous = atoms.at(-1);
	if (previous?.kind === 'text') previous.text += text;
	else atoms.push({ kind: 'text', text });
}

function createNode(): AddressNode {
	return { children: new Map() };
}

/**
 * Recognize the longest complete visible address at each position. The result deliberately
 * contains offsets into the untouched text so callers can decorate it without changing the DOM.
 */
export function createReferenceRecognizer(catalog: ReferenceCatalog): ReferenceRecognizer {
	const { addresses } = catalog;
	const root = createNode();
	for (const [targetItemKey, address] of addresses) {
		if (!address.address) continue;
		let node = root;
		for (let offset = 0; offset < address.address.length;) {
			const next = nextCharacter(address.address, offset)!;
			const key = normalizeReferenceAddress(next.character);
			let child = node.children.get(key);
			if (!child) {
				child = createNode();
				node.children.set(key, child);
			}
			node = child;
			offset = next.end;
		}
		const candidate: Candidate = {
			targetItemKey,
			address,
			bareAlphabetic: /^\p{L}+$/u.test(address.address)
		};
		if (node.candidate && node.candidate.targetItemKey !== targetItemKey) node.candidate = null;
		else if (node.candidate === undefined) node.candidate = candidate;
	}

	function matchesAt(text: string, start: number) {
		const matches: Match[] = [];
		let node = root;
		for (let offset = start; offset < text.length;) {
			const next = nextCharacter(text, offset)!;
			const child = node.children.get(normalizeReferenceAddress(next.character));
			if (!child) break;
			node = child;
			offset = next.end;
			if (!node.candidate) continue;
			const candidate = node.candidate;
			if (
				hasCompleteBoundaries(text, start, offset) &&
				(!candidate.bareAlphabetic || referenceIntroducer.test(text.slice(0, start)))
			)
				matches.push({ candidate, start, end: offset });
		}
		return matches;
	}

	return (text: string): ReferenceRecognition => {
		if (!text || !root.children.size)
			return { atoms: text ? [{ kind: 'text', text }] : [], references: [] };
		const matches = new Map<number, Match[]>();
		for (let start = 0; start < text.length;) {
			const local = matchesAt(text, start).sort((a, b) => b.end - a.end);
			if (local.length) matches.set(start, local);
			start = nextCharacter(text, start)!.end;
		}
		const firstAt = (start: number) => matches.get(start)?.[0];
		const atoms: ReplacementAtom[] = [];
		const references: RecognizedReference[] = [];
		let cursor = 0;
		while (cursor < text.length) {
			const first = firstAt(cursor);
			if (!first) {
				const next = nextCharacter(text, cursor)!;
				appendText(atoms, next.character);
				cursor = next.end;
				continue;
			}
			const separator = text.slice(first.end).match(rangeSeparator)?.[0];
			const second = separator ? firstAt(first.end + separator.length) : undefined;
			if (
				second &&
				catalog.canRange(first.candidate.targetItemKey, second.candidate.targetItemKey)
			) {
				const reference = cloneRangeReference(first.candidate, second.candidate, separator!);
				if (
					normalizeReferenceAddress(referenceText(reference, addresses)) ===
					normalizeReferenceAddress(text.slice(first.start, second.end))
				) {
					atoms.push(reference);
					references.push({ start: first.start, end: second.end, reference });
					cursor = second.end;
					continue;
				}
			}
			const reference = cloneReference(first.candidate);
			if (
				normalizeReferenceAddress(referenceText(reference, addresses)) ===
				normalizeReferenceAddress(text.slice(first.start, first.end))
			) {
				atoms.push(reference);
				references.push({ start: first.start, end: first.end, reference });
			} else appendText(atoms, text.slice(first.start, first.end));
			cursor = first.end;
		}
		return { atoms, references };
	};
}

/** Convert browser-visible replacement text into the persisted replacement atom model. */
export function recognizeReplacementContent(
	text: string,
	recognize: ReferenceRecognizer,
	paragraphs: boolean
): ReferenceRecognition {
	const lines = text.replace(/\r\n?/gu, '\n').split('\n');
	const atoms: ReplacementAtom[] = [];
	const references: RecognizedReference[] = [];
	let offset = 0;
	for (const [index, line] of lines.entries()) {
		const recognized = recognize(line);
		for (const atom of recognized.atoms) {
			if (atom.kind === 'text') appendText(atoms, atom.text);
			else atoms.push(atom);
		}
		for (const reference of recognized.references)
			references.push({
				...reference,
				start: offset + reference.start,
				end: offset + reference.end
			});
		if (index + 1 < lines.length) {
			if (paragraphs) atoms.push({ kind: 'paragraph-break' });
			else appendText(atoms, '\n');
			offset += line.length + 1;
		}
	}
	return { atoms, references };
}
