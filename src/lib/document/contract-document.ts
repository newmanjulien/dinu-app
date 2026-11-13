import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { ContractChange } from '../playbook/model';
import type { DocumentOverlayItem } from '../playbook/document-overlay';
import { DocumentCompositionEngine } from './compose';
import { buildSourceIndex, pointPosition } from './source-index';
import { targetContainers } from './ranges';
import { planStructuralChanges } from './structural-changes';
import { referenceText } from './numbering';
import { canonicalJson } from './canonical-json';
import type {
	InlineSource,
	SourceBlock,
	SourcePoint,
	SourceRange,
	SourceTarget
} from './source-model';

/** Coordinates refer to immutable content, independently of the pieces currently hosting it. */
export type OriginInterval = { sourceKey: string; start: number; end: number };
export type PieceLineage = {
	sourceKey: string;
	origin: OriginInterval;
	ancestors: OriginInterval[];
	/** Exact consumed coordinates for active-effect invalidation, separate from ancestry. */
	affectedRanges?: OriginInterval[];
	/** Frozen-original ranges for presentation grouping and deleted-text geometry only. */
	originalRanges?: OriginInterval[];
	createdBy?: string;
	annotationKind?: 'playbook' | 'buyer-proposal';
};
type AnnotationEffect = {
	id: string;
	structuralBlocks: string[];
	removedBlocks: string[];
};
export type ContractDocument = {
	blocks: SourceBlock[];
	pieces: PieceLineage[];
	aliases: [string, string][];
	removedBlocks: string[];
	/** Active buyer structure provenance, including changes that leave no text piece. */
	annotationEffects?: AnnotationEffect[];
};
/** Native Convex arrays are bounded even when total inline content is supported. */
export type ContractRenderTransport = {
	blocks: SourceBlock[];
	pieceGroups: {
		sourceKey: string;
		origin: OriginInterval;
		originalRangeGroups?: OriginInterval[][];
	}[][];
	aliasGroups: [string, string][][];
	removedBlockGroups: string[][];
};
const arrayGroups = <T>(rows: readonly T[], size = 4096): T[][] => {
	const result: T[][] = [];
	for (let offset = 0; offset < rows.length; offset += size)
		result.push(rows.slice(offset, offset + size));
	return result;
};
/** Rendering keeps the complete grouped original relation, without private dependency ancestry. */
export function contractDocumentToRenderTransport(
	document: ContractDocument
): ContractRenderTransport {
	const lineage = new Map(document.pieces.map((piece) => [piece.sourceKey, piece]));
	return {
		blocks: document.blocks,
		pieceGroups: document.blocks.map((block) =>
			block.kind === 'table'
				? []
				: block.content.map((atom) => {
						const piece = lineage.get(atom.sourceKey);
						if (!piece) throw new Error('Contract piece lineage is incomplete.');
						return {
							sourceKey: piece.sourceKey,
							origin: piece.origin,
							...(piece.originalRanges
								? { originalRangeGroups: arrayGroups(piece.originalRanges) }
								: {})
						};
					})
		),
		aliasGroups: arrayGroups(document.aliases),
		removedBlockGroups: arrayGroups(document.removedBlocks)
	};
}
export function contractDocumentFromRenderTransport(
	transport: ContractRenderTransport
): ContractDocument {
	if (
		transport.pieceGroups.length !== transport.blocks.length ||
		transport.blocks.some((block, index) => {
			const atoms = block.kind === 'table' ? [] : block.content;
			return (
				atoms.length !== transport.pieceGroups[index].length ||
				atoms.some((atom, i) => atom.sourceKey !== transport.pieceGroups[index][i].sourceKey)
			);
		})
	)
		throw new Error('Contract piece lineage is incomplete.');
	const document: ContractDocument = {
		blocks: transport.blocks,
		pieces: transport.pieceGroups.flatMap((group) =>
			group.map(({ sourceKey, origin, originalRangeGroups }) => ({
				sourceKey,
				origin,
				ancestors: [],
				...(originalRangeGroups ? { originalRanges: originalRangeGroups.flat() } : {})
			}))
		),
		aliases: transport.aliasGroups.flat(),
		removedBlocks: transport.removedBlockGroups.flat()
	};
	documentIndex(document);
	return document;
}
type Piece = { atom: InlineSource; lineage: PieceLineage };
type Fragment = { range: SourceRange; pieces: Piece[] };
type Section = {
	blocks: SourceBlock[];
	pieces: PieceLineage[];
	removedBlocks: string[];
	annotationEffects?: AnnotationEffect[];
};
type TextPatch = { kind: 'text'; blockKey: string; before: Fragment; after: Fragment };
type StructuralPatch = {
	kind: 'structure';
	before: Section;
	after: Section;
	previousBlockKey: string | null;
	nextBlockKey: string | null;
};
/** Payload is immutable. Lifecycle, review decisions and current intent live outside it. */
export type DocumentChange = {
	id: string;
	annotationKind?: 'playbook' | 'buyer-proposal';
	dependencies: string[];
	parts: (TextPatch | StructuralPatch)[];
	aliasesBefore: [string, string][];
	aliasesAfter: [string, string][];
};

export class DocumentChangeConflict extends Error {
	constructor(message = 'The affected wording changed. Reload and review this clause again.') {
		super(message);
		this.name = 'DocumentChangeConflict';
	}
}
const clone = <T>(value: T): T => structuredClone(value);
const digest = (value: unknown) =>
	bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))));
const length = (atom: InlineSource) => (atom.kind === 'text' ? atom.text.length : 1);
const keyFor = (origin: OriginInterval) => `piece:${digest(origin)}`;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function originIntervals(intervals: readonly OriginInterval[]): OriginInterval[] {
	const bySource = new Map<string, OriginInterval[]>();
	for (const interval of intervals) {
		const rows = bySource.get(interval.sourceKey) ?? [];
		rows.push(interval);
		bySource.set(interval.sourceKey, rows);
	}
	return [...bySource.values()].flatMap((rows) => {
		const merged: OriginInterval[] = [];
		for (const interval of rows.toSorted((a, b) => a.start - b.start || a.end - b.end)) {
			const previous = merged.at(-1);
			if (previous && previous.end >= interval.start)
				previous.end = Math.max(previous.end, interval.end);
			else merged.push({ ...interval });
		}
		return merged;
	});
}

export function createContractDocument(blocks: readonly SourceBlock[]): ContractDocument {
	buildSourceIndex(blocks);
	return {
		blocks: blocks.map((block, order) => ({ ...clone(block), order })),
		aliases: [],
		removedBlocks: [],
		pieces: blocks.flatMap((block) =>
			block.kind === 'table'
				? []
				: block.content.map((atom) => ({
						sourceKey: atom.sourceKey,
						origin: { sourceKey: atom.sourceKey, start: 0, end: length(atom) },
						ancestors: [],
						originalRanges: [{ sourceKey: atom.sourceKey, start: 0, end: length(atom) }]
					}))
		)
	};
}

export function documentIndex(document: ContractDocument) {
	if (document.aliases.some((pair) => pair.length !== 2 || pair.some((key) => !key.trim())))
		throw new Error('Contract paragraph aliases are incomplete.');
	return buildSourceIndex(document.blocks, { aliases: new Map(document.aliases) });
}
function pieceMap(document: ContractDocument) {
	return new Map(document.pieces.map((piece) => [piece.sourceKey, piece]));
}
function piecesFor(
	document: ContractDocument,
	block: SourceBlock,
	lineage: ReadonlyMap<string, PieceLineage> = pieceMap(document)
): Piece[] {
	if (block.kind === 'table') throw new DocumentChangeConflict('Tables cannot be edited.');
	return block.content.map((atom) => {
		const piece = lineage.get(atom.sourceKey);
		if (!piece) throw new Error('Contract piece lineage is incomplete.');
		return { atom, lineage: piece };
	});
}
function slice(piece: Piece, start: number, end: number): Piece {
	if (piece.atom.kind === 'reference' && (start !== 0 || end !== 1))
		throw new DocumentChangeConflict('References must be changed as a whole.');
	const origin = {
		...piece.lineage.origin,
		start: piece.lineage.origin.start + start,
		end: piece.lineage.origin.start + end
	};
	const sourceKey =
		start === 0 && end === length(piece.atom) ? piece.atom.sourceKey : keyFor(origin);
	return {
		atom: {
			...piece.atom,
			sourceKey,
			...(piece.atom.kind === 'text' ? { text: piece.atom.text.slice(start, end) } : {})
		},
		lineage: {
			...piece.lineage,
			sourceKey,
			origin,
			...(piece.lineage.originalRanges
				? {
						originalRanges: piece.lineage.originalRanges.map((range) =>
							range.sourceKey === piece.lineage.origin.sourceKey
								? { ...range, start: range.start + start, end: range.start + end }
								: range
						)
					}
				: {})
		}
	};
}
function canonicalPoint(piece: Piece, offset: number): SourcePoint {
	return { sourceKey: piece.lineage.origin.sourceKey, offset: piece.lineage.origin.start + offset };
}
function locate(
	pieces: Piece[],
	point: SourcePoint,
	ending: boolean
): { index: number; offset: number } {
	const matches: { index: number; offset: number }[] = [];
	for (const [index, piece] of pieces.entries()) {
		if (
			piece.atom.sourceKey === point.sourceKey &&
			point.offset >= 0 &&
			point.offset <= length(piece.atom)
		)
			matches.push({ index, offset: point.offset });
		else if (
			piece.lineage.origin.sourceKey === point.sourceKey &&
			point.offset >= piece.lineage.origin.start &&
			point.offset <= piece.lineage.origin.end
		)
			matches.push({ index, offset: point.offset - piece.lineage.origin.start });
	}
	const chosen = ending
		? (matches.findLast((match) => match.offset > 0) ?? matches.at(-1))
		: (matches.find((match) => match.offset < length(pieces[match.index].atom)) ?? matches[0]);
	if (!chosen) throw new DocumentChangeConflict();
	return chosen;
}
function extract(pieces: Piece[], range: SourceRange) {
	const start = locate(pieces, range.start, false),
		end = same(range.start, range.end) ? start : locate(pieces, range.end, true);
	if (start.index > end.index || (start.index === end.index && start.offset > end.offset))
		throw new DocumentChangeConflict();
	const result = pieces
		.slice(start.index, end.index + 1)
		.map((piece, i, rows) =>
			slice(
				piece,
				i === 0 ? start.offset : 0,
				i === rows.length - 1 ? end.offset : length(piece.atom)
			)
		);
	return { start, end, pieces: result };
}
function semanticPieces(pieces: Piece[]) {
	// Piece splitting is an implementation detail, not a conflicting edit. Coalesce adjoining
	// intervals of the same immutable origin before checking exact content.
	const result: {
		origin: OriginInterval;
		atom:
			| Omit<Extract<InlineSource, { kind: 'text' }>, 'sourceKey'>
			| Omit<Extract<InlineSource, { kind: 'reference' }>, 'sourceKey'>;
	}[] = [];
	for (const piece of pieces) {
		const { sourceKey: _sourceKey, ...atom } = piece.atom;
		const previous = result.at(-1);
		if (
			previous?.atom.kind === 'text' &&
			atom.kind === 'text' &&
			previous.origin.sourceKey === piece.lineage.origin.sourceKey &&
			previous.origin.end === piece.lineage.origin.start
		) {
			previous.origin.end = piece.lineage.origin.end;
			previous.atom.text += atom.text;
		} else result.push({ origin: { ...piece.lineage.origin }, atom });
	}
	return result;
}
function replacePieces(
	document: ContractDocument,
	blockKey: string,
	before: Fragment,
	after: Fragment
) {
	const block = document.blocks.find((block) => block.blockKey === blockKey);
	if (!block || block.kind === 'table') throw new DocumentChangeConflict();
	const pieces = piecesFor(document, block),
		found = extract(pieces, before.range);
	if (!same(semanticPieces(found.pieces), semanticPieces(before.pieces)))
		throw new DocumentChangeConflict();
	const prefix = pieces.slice(0, found.start.index),
		suffix = pieces.slice(found.end.index + 1);
	const first = pieces[found.start.index],
		last = pieces[found.end.index];
	if (found.start.offset > 0) prefix.push(slice(first, 0, found.start.offset));
	if (found.end.offset < length(last.atom))
		suffix.unshift(slice(last, found.end.offset, length(last.atom)));
	const replacement = [...prefix, ...clone(after.pieces), ...suffix];
	block.content = replacement.map((piece) => piece.atom);
	const retired = new Set(pieces.map((piece) => piece.atom.sourceKey));
	document.pieces = [
		...document.pieces.filter((piece) => !retired.has(piece.sourceKey)),
		...replacement.map((piece) => piece.lineage)
	];
}

/** Resolve immutable original coordinates through current pieces. Ancestor lookup is explicit:
 * partial addressing inside a replaced fragment is ambiguous and is never guessed. */
export function documentMapping(document: ContractDocument) {
	const lineage = pieceMap(document);
	const pieces = document.blocks.flatMap((block) =>
		block.kind === 'table' ? [] : piecesFor(document, block, lineage)
	);
	type Entry = { piece: Piece; ordinal: number };
	const current = new Map<string, Entry[]>(),
		origins = new Map<string, Entry[]>(),
		starts = new Map<string, Map<number, Entry[]>>(),
		ends = new Map<string, Map<number, Entry[]>>();
	function add<K>(buckets: Map<K, Entry[]>, key: K, entry: Entry) {
		const bucket = buckets.get(key);
		if (!bucket) buckets.set(key, [entry]);
		else if (bucket.at(-1) !== entry) bucket.push(entry);
	}
	for (const [ordinal, piece] of pieces.entries()) {
		const entry = { piece, ordinal };
		add(current, piece.atom.sourceKey, entry);
		add(origins, piece.lineage.origin.sourceKey, entry);
		for (const ancestor of piece.lineage.ancestors) {
			for (const [buckets, offset] of [
				[starts, ancestor.start],
				[ends, ancestor.end]
			] as const) {
				let offsets = buckets.get(ancestor.sourceKey);
				if (!offsets) buckets.set(ancestor.sourceKey, (offsets = new Map()));
				add(offsets, offset, entry);
			}
		}
	}
	let index: ReturnType<typeof documentIndex> | undefined;
	return {
		index: () => (index ??= documentIndex(document)),
		piecesForPoint(point: SourcePoint) {
			// Merge document-ordered buckets, keeping a piece present in both only once.
			// locate still chooses current coordinates before origin coordinates per piece.
			const a = current.get(point.sourceKey) ?? [],
				b = origins.get(point.sourceKey) ?? [],
				candidates: Piece[] = [];
			let i = 0,
				j = 0;
			while (i < a.length || j < b.length) {
				const left = a[i],
					right = b[j];
				if (left && (!right || left.ordinal <= right.ordinal)) {
					candidates.push(left.piece);
					i++;
					if (left === right) j++;
				} else {
					candidates.push(right.piece);
					j++;
				}
			}
			return candidates;
		},
		descendantForPoint(point: SourcePoint, ending: boolean) {
			const candidates = (ending ? ends : starts).get(point.sourceKey)?.get(point.offset);
			return (ending ? candidates?.at(-1) : candidates?.[0])?.piece;
		}
	};
}

export function mapDocumentTarget(
	document: ContractDocument,
	target: SourceTarget,
	descendants = false,
	mapping = documentMapping(document)
): SourceTarget {
	if (target.kind === 'boundary') {
		if (!mapping.index().structuralBoundaries.has(target.afterBlockKey))
			throw new DocumentChangeConflict();
		return clone(target);
	}
	const resolve = (point: SourcePoint, ending: boolean) => {
		if (point.sourceKey.startsWith('number:')) {
			const unit = mapping.index().byKey.get(point.sourceKey);
			if (!unit || (point.offset !== 0 && point.offset !== 1)) throw new DocumentChangeConflict();
			return clone(point);
		}
		try {
			const candidates = mapping.piecesForPoint(point),
				found = locate(candidates, point, ending);
			return { sourceKey: candidates[found.index].atom.sourceKey, offset: found.offset };
		} catch (error) {
			if (!descendants) throw error;
			const piece = mapping.descendantForPoint(point, ending);
			if (!piece) throw error;
			return { sourceKey: piece.atom.sourceKey, offset: ending ? length(piece.atom) : 0 };
		}
	};
	return {
		kind: 'text',
		range: { start: resolve(target.range.start, false), end: resolve(target.range.end, true) }
	};
}

function fragment(document: ContractDocument, block: SourceBlock, range: SourceRange): Fragment {
	const pieces = piecesFor(document, block),
		selected = extract(pieces, range);
	return {
		range: {
			start: canonicalPoint(pieces[selected.start.index], selected.start.offset),
			end: canonicalPoint(pieces[selected.end.index], selected.end.offset)
		},
		pieces: clone(selected.pieces)
	};
}
function replacementPieces(
	change: ContractChange,
	id: string,
	index: number,
	ancestors: OriginInterval[],
	originalRanges: OriginInterval[]
): Piece[] {
	const atoms = change.replacement.filter((atom) => atom.kind !== 'paragraph-break');
	const lineage = originIntervals(ancestors);
	return (atoms.length ? atoms : [{ kind: 'text' as const, text: '' }]).map((atom, atomIndex) => {
		const sourceKey = `change:${id}:${index}:${atomIndex}`,
			atomLength = atom.kind === 'text' ? atom.text.length : 1;
		const piece = {
			atom: { ...clone(atom), sourceKey },
			lineage: {
				sourceKey,
				origin: { sourceKey, start: 0, end: atomLength },
				// Only the replacement's edges need to carry old range boundaries. This avoids
				// multiplying a large selection's ancestry by every inserted inline atom.
				ancestors: atomIndex === 0 || atomIndex === atoms.length - 1 ? clone(lineage) : [],
				originalRanges: clone(originalRanges),
				affectedRanges: clone(lineage),
				createdBy: id
			}
		};
		return piece;
	});
}
function rangeFor(pieces: Piece[]): SourceRange {
	return {
		start: canonicalPoint(pieces[0], 0),
		end: canonicalPoint(pieces.at(-1)!, length(pieces.at(-1)!.atom))
	};
}
function section(document: ContractDocument, start: number, end: number): Section {
	const blocks = clone(document.blocks.slice(start, end)),
		keys = new Set(
			blocks.flatMap((block) =>
				block.kind === 'table' ? [] : block.content.map((atom) => atom.sourceKey)
			)
		);
	return {
		blocks,
		pieces: clone(document.pieces.filter((piece) => keys.has(piece.sourceKey))),
		removedBlocks: clone(document.removedBlocks),
		...(document.annotationEffects ? { annotationEffects: clone(document.annotationEffects) } : {})
	};
}

/** Capture every precondition before committing any database writes. The returned patch can
 * combine with disjoint edits, including another edit in the same paragraph. */
export function prepareDocumentChange(
	document: ContractDocument,
	changes: readonly ContractChange[],
	id: string
): DocumentChange {
	if (!id.trim() || !changes.length)
		throw new DocumentChangeConflict('A wording change is required.');
	const working = clone(document),
		parts: DocumentChange['parts'] = [],
		dependencies = new Set<string>();
	for (const [index, authored] of changes.entries()) {
		const target = mapDocumentTarget(working, authored.target),
			change = { ...clone(authored), target },
			source = documentIndex(working);
		const containers = targetContainers(source, target),
			units =
				target.kind === 'text'
					? source.units.filter(
							(unit) =>
								unit.position < pointPosition(source, target.range.end) &&
								unit.position + unit.length > pointPosition(source, target.range.start)
						)
					: [];
		const textOnly =
			target.kind === 'text' &&
			containers.length === 1 &&
			!units.some((unit) => unit.kind === 'number') &&
			!change.replacement.some((atom) => atom.kind === 'paragraph-break');
		if (textOnly && target.kind === 'text') {
			const block = source.blocks.get(containers[0].blockKey)!,
				before = fragment(working, block, target.range);
			for (const piece of before.pieces)
				if (piece.lineage.createdBy) dependencies.add(piece.lineage.createdBy);
			const ancestry = before.pieces.flatMap((piece) => [
				piece.lineage.origin,
				...piece.lineage.ancestors
			]);
			const afterPieces = replacementPieces(
					change,
					id,
					index,
					ancestry,
					originIntervals(before.pieces.flatMap((piece) => piece.lineage.originalRanges ?? []))
				),
				after = { range: rangeFor(afterPieces), pieces: afterPieces };
			const part: TextPatch = { kind: 'text', blockKey: block.blockKey, before, after };
			replacePieces(working, block.blockKey, before, after);
			parts.push(part);
		} else {
			const touched =
				target.kind === 'boundary'
					? [source.blockOrdinals.get(target.afterBlockKey)!]
					: containers.map((container) => source.blockOrdinals.get(container.blockKey)!);
			const start = Math.min(...touched),
				end = Math.max(...touched) + 1;
			const before = section(working, start, end);
			for (const piece of before.pieces) if (piece.createdBy) dependencies.add(piece.createdBy);
			const previousBlockKey = working.blocks[start - 1]?.blockKey ?? null,
				nextBlockKey = working.blocks[end]?.blockKey ?? null;
			const materialized = materialize(working, [change], `${id}:${index}`);
			const afterStart = previousBlockKey
				? materialized.blocks.findIndex((block) => block.blockKey === previousBlockKey) + 1
				: 0;
			const afterEnd = nextBlockKey
				? materialized.blocks.findIndex((block) => block.blockKey === nextBlockKey)
				: materialized.blocks.length;
			parts.push({
				kind: 'structure',
				before,
				after: section(materialized, afterStart, afterEnd),
				previousBlockKey,
				nextBlockKey
			});
			Object.assign(working, materialized);
		}
	}
	return {
		id,
		dependencies: [...dependencies].filter((dep) => dep !== id),
		parts,
		aliasesBefore: clone(document.aliases),
		aliasesAfter: clone(working.aliases)
	};
}

function materialize(
	document: ContractDocument,
	changes: ContractChange[],
	id: string
): ContractDocument {
	const source = documentIndex(document),
		item: DocumentOverlayItem = {
			itemId: id,
			trigger: { id, target: changes[0].target },
			annotations: [],
			concessions: [{ id: 'apply', changes }]
		};
	const origins = changes.map((change, changeIndex) => ({
		change,
		origin: { itemId: id, concessionId: 'apply', changeIndex },
		annotation: {
			target: change.target,
			origin: { itemId: id, concessionId: 'apply', changeIndex }
		}
	}));
	const structural = planStructuralChanges(source, document.blocks, origins),
		aliases = new Map([...document.aliases, ...structural.aliases]);
	const engine = new DocumentCompositionEngine(
		document.blocks,
		source,
		undefined,
		new Map(document.aliases)
	);
	const resolved = [
		...engine.compose({ items: [item], activeConcessions: { [id]: 'apply' }, view: 'effective' })
	];
	const metadata = new Map(engine.numberingBlocks.map((block) => [block.blockKey, block])),
		originalPieces = pieceMap(document);
	const originalBlocks = new Map(document.blocks.map((block) => [block.blockKey, block]));
	const touchedBlocks = new Set(
		changes.flatMap((change) =>
			targetContainers(source, change.target).map((container) => container.blockKey)
		)
	);
	const originalAtoms = new Map(
		document.blocks.flatMap((block) =>
			block.kind === 'table' ? [] : block.content.map((atom) => [atom.sourceKey, atom] as const)
		)
	);
	const ancestry = originIntervals(
		changes.flatMap((change) =>
			targetContainers(source, change.target).flatMap((container) =>
				container.units.flatMap((unit) => {
					const piece = originalPieces.get(unit.sourceKey);
					return piece ? [piece.origin, ...piece.ancestors] : [];
				})
			)
		)
	);
	const originalRanges = originIntervals(
		changes.flatMap((change) =>
			targetContainers(source, change.target).flatMap((container) =>
				container.units.flatMap((unit) => originalPieces.get(unit.sourceKey)?.originalRanges ?? [])
			)
		)
	);
	const affectedRanges = originIntervals(
		changes.flatMap((change) => {
			if (change.target.kind === 'boundary') return [];
			const start = pointPosition(source, change.target.range.start);
			const end = pointPosition(source, change.target.range.end);
			return source.units.flatMap((unit) => {
				if (unit.kind === 'number' || unit.position >= end || unit.position + unit.length <= start)
					return [];
				const piece = originalPieces.get(unit.sourceKey);
				if (!piece) return [];
				return [
					{
						...piece.origin,
						start: piece.origin.start + Math.max(0, start - unit.position),
						end: piece.origin.start + Math.min(unit.length, end - unit.position)
					},
					...(piece.affectedRanges ?? [])
				];
			});
		})
	);
	const pieces: PieceLineage[] = [],
		rename = new Map<string, string>();
	for (const block of engine.numberingBlocks)
		if (block.blockKey.startsWith('insert:'))
			rename.set(block.blockKey, `block:${digest([id, block.blockKey])}`);
	const blocks: SourceBlock[] = resolved.map((block, order) => {
		if (block.kind === 'table') return { ...clone(block), order };
		const original = originalBlocks.get(block.blockKey);
		if (original && original.kind !== 'table' && !touchedBlocks.has(block.blockKey)) {
			// Rendering omits empty source atoms. Unaffected paragraphs must retain their exact
			// source and lineage so later disjoint changes still match their captured base.
			pieces.push(...original.content.map((atom) => clone(originalPieces.get(atom.sourceKey)!)));
			return { ...clone(original), order };
		}
		const meta = metadata.get(block.blockKey);
		if (!meta || meta.kind === 'table')
			throw new Error('Materialized paragraph metadata is missing.');
		const content: InlineSource[] = [];
		for (const [runIndex, run] of block.content.entries()) {
			if (
				run.sourceKind === 'number' ||
				run.generated === 'number' ||
				run.generated === 'separator' ||
				run.generated === 'empty-hit-target'
			)
				continue;
			if (run.source) {
				const atom = originalAtoms.get(run.source.start.sourceKey),
					lineage = originalPieces.get(run.source.start.sourceKey);
				if (!atom || !lineage) throw new Error('Materialized source provenance is missing.');
				const piece = slice({ atom, lineage }, run.source.start.offset, run.source.end.offset);
				content.push(piece.atom);
				pieces.push(piece.lineage);
			} else if (run.generated === 'replacement' && run.generatedOrigin) {
				const sourceKey = `change:${id}:${run.generatedOrigin.changeIndex}:${run.generatedOffset ?? 0}:${runIndex}`;
				let atom: InlineSource = { kind: 'text', text: run.text, sourceKey };
				if (run.discussion?.atomic) {
					let offset = 0;
					for (const replacement of changes[run.generatedOrigin.changeIndex].replacement) {
						if (replacement.kind === 'reference' && offset === run.generatedOffset) {
							atom = { ...clone(replacement), sourceKey };
							break;
						}
						offset +=
							replacement.kind === 'text'
								? replacement.text.length
								: replacement.kind === 'reference'
									? referenceText(replacement, engine.addresses).length
									: 1;
					}
					if (atom.kind !== 'reference')
						throw new Error('Materialized reference provenance is missing.');
				}
				content.push(atom);
				pieces.push({
					sourceKey,
					origin: { sourceKey, start: 0, end: length(atom) },
					ancestors: clone(ancestry),
					originalRanges: clone(originalRanges),
					affectedRanges: clone(affectedRanges),
					createdBy: id.split(':').slice(0, -1).join(':')
				});
			}
		}
		if (!content.length) {
			const sourceKey = `empty:${id}:${order}`;
			content.push({ kind: 'text', sourceKey, text: '' });
			pieces.push({
				sourceKey,
				origin: { sourceKey, start: 0, end: 0 },
				ancestors: clone(ancestry),
				originalRanges: clone(originalRanges),
				affectedRanges: clone(affectedRanges),
				createdBy: id.split(':').slice(0, -1).join(':')
			});
		}
		return {
			...clone(meta),
			blockKey: rename.get(block.blockKey) ?? block.blockKey,
			order,
			role: block.role,
			content,
			...(meta.numbering
				? {
						numbering: {
							...meta.numbering,
							itemKey: rename.get(meta.numbering.itemKey) ?? meta.numbering.itemKey,
							...(meta.numbering.parentItemKey
								? {
										parentItemKey:
											rename.get(meta.numbering.parentItemKey) ?? meta.numbering.parentItemKey
									}
								: {})
						}
					}
				: {})
		};
	});
	for (const block of blocks)
		if (block.kind !== 'table')
			for (const atom of block.content)
				if (atom.kind === 'reference') {
					atom.targetItemKey = rename.get(atom.targetItemKey) ?? atom.targetItemKey;
					if (atom.endTargetItemKey)
						atom.endTargetItemKey = rename.get(atom.endTargetItemKey) ?? atom.endTargetItemKey;
				}
	const generatedPieces = pieces.filter(
		(piece) =>
			piece.createdBy === id.split(':').slice(0, -1).join(':') &&
			piece.origin.sourceKey.startsWith(`change:${id}:`)
	);
	for (const piece of generatedPieces.slice(1, -1)) piece.ancestors = [];
	return {
		blocks,
		pieces,
		aliases: [...aliases].map(([from, to]) => [rename.get(from) ?? from, rename.get(to) ?? to]),
		removedBlocks: [...new Set([...document.removedBlocks, ...structural.removed])],
		...(document.annotationEffects ? { annotationEffects: clone(document.annotationEffects) } : {})
	};
}

function apply(
	document: ContractDocument,
	patch: DocumentChange,
	reverse: boolean
): ContractDocument {
	const result = clone(document),
		effects = new Map((document.annotationEffects ?? []).map((effect) => [effect.id, effect])),
		parts = reverse ? [...patch.parts].reverse() : patch.parts;
	const structuralBlocks = new Set<string>(),
		removedByPatch = new Set<string>();
	for (const part of parts) {
		const before = reverse ? part.after : part.before,
			after = reverse ? part.before : part.after;
		if (part.kind === 'text')
			replacePieces(result, part.blockKey, before as Fragment, after as Fragment);
		else {
			const expected = before as Section,
				replacement = after as Section;
			const expectedEffects = new Map(
					(expected.annotationEffects ?? []).map((effect) => [effect.id, effect])
				),
				replacementEffects = new Map(
					(replacement.annotationEffects ?? []).map((effect) => [effect.id, effect])
				);
			for (const id of new Set([...expectedEffects.keys(), ...replacementEffects.keys()])) {
				if (same(expectedEffects.get(id) ?? null, replacementEffects.get(id) ?? null)) continue;
				const effect = replacementEffects.get(id);
				if (effect) effects.set(id, clone(effect));
				else effects.delete(id);
			}
			for (const block of part.before.blocks) structuralBlocks.add(block.blockKey);
			const previous = part.previousBlockKey
				? result.blocks.findIndex((block) => block.blockKey === part.previousBlockKey)
				: -1;
			if (part.previousBlockKey && previous === -1) throw new DocumentChangeConflict();
			const start = previous + 1;
			const end = part.nextBlockKey
				? result.blocks.findIndex((block) => block.blockKey === part.nextBlockKey)
				: result.blocks.length;
			if (
				start < 0 ||
				end < start ||
				!same(
					section(result, start, end).blocks.map(({ order: _order, ...block }) => block),
					expected.blocks.map(({ order: _order, ...block }) => block)
				)
			)
				throw new DocumentChangeConflict();
			const keys = new Set(
				result.blocks
					.slice(start, end)
					.flatMap((block) =>
						block.kind === 'table' ? [] : block.content.map((atom) => atom.sourceKey)
					)
			);
			result.blocks.splice(start, end - start, ...clone(replacement.blocks));
			result.pieces = [
				...result.pieces.filter((piece) => !keys.has(piece.sourceKey)),
				...clone(replacement.pieces)
			];
			const added = replacement.removedBlocks.filter(
				(key) => !expected.removedBlocks.includes(key)
			);
			const removed = expected.removedBlocks.filter(
				(key) => !replacement.removedBlocks.includes(key)
			);
			for (const key of added) removedByPatch.add(key);
			result.removedBlocks = [
				...new Set([...result.removedBlocks.filter((key) => !removed.includes(key)), ...added])
			];
		}
	}
	const beforeAliases = new Map(reverse ? patch.aliasesAfter : patch.aliasesBefore),
		afterAliases = new Map(reverse ? patch.aliasesBefore : patch.aliasesAfter),
		currentAliases = new Map(result.aliases);
	for (const key of new Set([...beforeAliases.keys(), ...afterAliases.keys()])) {
		if (beforeAliases.get(key) === afterAliases.get(key)) continue;
		if (currentAliases.get(key) !== beforeAliases.get(key))
			throw new DocumentChangeConflict('Paragraph numbering changed. Review this clause again.');
		const value = afterAliases.get(key);
		if (value === undefined) currentAliases.delete(key);
		else currentAliases.set(key, value);
	}
	result.aliases = [...currentAliases];
	result.blocks = result.blocks.map((block, order) => ({ ...block, order }));
	const lineage = pieceMap(result);
	result.pieces = result.blocks.flatMap((block) =>
		block.kind === 'table'
			? []
			: block.content.map((atom) => {
					const piece = lineage.get(atom.sourceKey);
					if (!piece) throw new Error('Contract piece lineage is incomplete.');
					return piece;
				})
	);
	for (const piece of result.pieces)
		if (piece.createdBy === patch.id && patch.annotationKind)
			piece.annotationKind = patch.annotationKind;
	if (reverse) effects.delete(patch.id);
	else if (patch.annotationKind === 'buyer-proposal' && structuralBlocks.size)
		effects.set(patch.id, {
			id: patch.id,
			structuralBlocks: [...structuralBlocks],
			removedBlocks: [...removedByPatch]
		});
	const represented = new Set(
			result.pieces.flatMap((piece) => (piece.createdBy ? [piece.createdBy] : []))
		),
		removed = new Set(result.removedBlocks);
	const activeEffects = [...effects.values()]
		.map((effect) => ({
			...effect,
			removedBlocks: effect.removedBlocks.filter((key) => removed.has(key))
		}))
		.filter((effect) => represented.has(effect.id) || effect.removedBlocks.length);
	if (activeEffects.length) result.annotationEffects = activeEffects;
	else delete result.annotationEffects;
	documentIndex(result);
	return result;
}
export const applyDocumentChange = (document: ContractDocument, patch: DocumentChange) =>
	apply(document, patch, false);
export const reverseDocumentChange = (document: ContractDocument, patch: DocumentChange) =>
	apply(document, patch, true);

function patchDependencies(parts: DocumentChange['parts'], id: string) {
	return [
		...new Set(
			parts.flatMap((part) =>
				part.kind === 'text'
					? part.before.pieces.flatMap((piece) =>
							piece.lineage.createdBy ? [piece.lineage.createdBy] : []
						)
					: part.before.pieces.flatMap((piece) => (piece.createdBy ? [piece.createdBy] : []))
			)
		)
	].filter((value) => value !== id);
}

type PositionedPiece = { piece: Piece; start: number; end: number };
function positioned(pieces: Piece[]): PositionedPiece[] {
	let offset = 0;
	return pieces.map((piece) => {
		const start = offset;
		offset += length(piece.atom);
		return { piece, start, end: offset };
	});
}
function atPosition(pieces: PositionedPiece[], position: number, ending: boolean): SourcePoint {
	const found = ending
		? (pieces.findLast((piece) => piece.start < position && piece.end >= position) ?? pieces[0])
		: (pieces.find((piece) => piece.start <= position && piece.end > position) ?? pieces.at(-1)!);
	return canonicalPoint(found.piece, position - found.start);
}
function positionedFragment(pieces: PositionedPiece[], start: number, end: number): Fragment {
	const selected = pieces
		.filter((piece) =>
			piece.start === piece.end
				? piece.start >= start && piece.start <= end
				: piece.end > start && piece.start < end
		)
		.map((piece) =>
			slice(
				piece.piece,
				Math.max(0, start - piece.start),
				Math.min(length(piece.piece.atom), end - piece.start)
			)
		);
	const range = selected.length
		? {
				start: canonicalPoint(selected[0], 0),
				end: canonicalPoint(selected.at(-1)!, length(selected.at(-1)!.atom))
			}
		: { start: atPosition(pieces, start, false), end: atPosition(pieces, end, true) };
	if (start === end && !selected.length) range.end = clone(range.start);
	if (!selected.length) {
		const found = locate(
			pieces.map((piece) => piece.piece),
			range.start,
			false
		);
		selected.push(slice(pieces[found.index].piece, found.offset, found.offset));
	}
	return { range, pieces: clone(selected) };
}

/** Compare immutable origins, so unrelated wording between two changed spans stays independent. */
function textDifference(
	beforeDocument: ContractDocument,
	afterDocument: ContractDocument,
	beforeBlock: SourceBlock,
	afterBlock: SourceBlock,
	beforeLineage: ReadonlyMap<string, PieceLineage>,
	afterLineage: ReadonlyMap<string, PieceLineage>
): TextPatch[] {
	const before = positioned(piecesFor(beforeDocument, beforeBlock, beforeLineage)),
		after = positioned(piecesFor(afterDocument, afterBlock, afterLineage));
	const byOrigin = new Map<string, PositionedPiece[]>();
	for (const piece of after) {
		const rows = byOrigin.get(piece.piece.lineage.origin.sourceKey) ?? [];
		rows.push(piece);
		byOrigin.set(piece.piece.lineage.origin.sourceKey, rows);
	}
	const anchors: { before: number; after: number; length: number }[] = [];
	for (const original of before)
		for (const current of byOrigin.get(original.piece.lineage.origin.sourceKey) ?? []) {
			const start = Math.max(
				original.piece.lineage.origin.start,
				current.piece.lineage.origin.start
			);
			const end = Math.min(original.piece.lineage.origin.end, current.piece.lineage.origin.end);
			if (end <= start) continue;
			const left = slice(
				original.piece,
				start - original.piece.lineage.origin.start,
				end - original.piece.lineage.origin.start
			);
			const right = slice(
				current.piece,
				start - current.piece.lineage.origin.start,
				end - current.piece.lineage.origin.start
			);
			if (!same(semanticPieces([left]), semanticPieces([right]))) continue;
			anchors.push({
				before: original.start + start - original.piece.lineage.origin.start,
				after: current.start + start - current.piece.lineage.origin.start,
				length: end - start
			});
		}
	anchors.sort((a, b) => a.before - b.before || a.after - b.after);
	const parts: TextPatch[] = [];
	let beforeCursor = 0,
		afterCursor = 0;
	for (const anchor of [
		...anchors,
		{ before: before.at(-1)!.end, after: after.at(-1)!.end, length: 0 }
	]) {
		if (anchor.before < beforeCursor || anchor.after < afterCursor)
			throw new DocumentChangeConflict('The wording order changed.');
		if (anchor.before > beforeCursor || anchor.after > afterCursor)
			parts.push({
				kind: 'text',
				blockKey: beforeBlock.blockKey,
				before: positionedFragment(before, beforeCursor, anchor.before),
				after: positionedFragment(after, afterCursor, anchor.after)
			});
		beforeCursor = anchor.before + anchor.length;
		afterCursor = anchor.after + anchor.length;
	}
	if (
		!parts.length &&
		!same(
			semanticPieces(before.map((row) => row.piece)),
			semanticPieces(after.map((row) => row.piece))
		)
	)
		parts.push({
			kind: 'text',
			blockKey: beforeBlock.blockKey,
			before: positionedFragment(before, 0, before.at(-1)!.end),
			after: positionedFragment(after, 0, after.at(-1)!.end)
		});
	return parts;
}

export function captureDocumentDifference(
	before: ContractDocument,
	after: ContractDocument,
	id: string
): DocumentChange {
	const parts: DocumentChange['parts'] = [];
	const beforeLineage = pieceMap(before),
		afterLineage = pieceMap(after);
	const metadata = (block: SourceBlock) => {
		const { order: _order, ...rest } = block;
		return block.kind === 'table' ? rest : { ...rest, content: [] };
	};
	const afterOrdinals = new Map(after.blocks.map((block, index) => [block.blockKey, index]));
	const anchors = before.blocks.flatMap((block, index) => {
		const next = afterOrdinals.get(block.blockKey);
		return next !== undefined && same(metadata(block), metadata(after.blocks[next]))
			? [{ before: index, after: next, key: block.blockKey }]
			: [];
	});
	let beforeCursor = 0,
		afterCursor = 0,
		previousBlockKey: string | null = null;
	for (const anchor of [
		...anchors,
		{ before: before.blocks.length, after: after.blocks.length, key: null }
	]) {
		if (anchor.before < beforeCursor || anchor.after < afterCursor)
			throw new DocumentChangeConflict('The paragraph order changed.');
		if (anchor.before > beforeCursor || anchor.after > afterCursor)
			parts.push({
				kind: 'structure',
				before: section(before, beforeCursor, anchor.before),
				after: section(after, afterCursor, anchor.after),
				previousBlockKey,
				nextBlockKey: anchor.key
			});
		if (anchor.key && before.blocks[anchor.before].kind !== 'table')
			parts.push(
				...textDifference(
					before,
					after,
					before.blocks[anchor.before],
					after.blocks[anchor.after],
					beforeLineage,
					afterLineage
				)
			);
		beforeCursor = anchor.before + 1;
		afterCursor = anchor.after + 1;
		previousBlockKey = anchor.key;
	}
	return {
		id,
		parts,
		dependencies: patchDependencies(parts, id),
		aliasesBefore: clone(before.aliases),
		aliasesAfter: clone(after.aliases)
	};
}

/** Resolve a widget's new variant against its original base, then capture actual current→new
 * wording. Predecessors are newest first; no intermediate inverse is stored or published. */
export function prepareDocumentTransition(
	document: ContractDocument,
	predecessors: readonly DocumentChange[],
	changes: readonly ContractChange[],
	id: string
): DocumentChange {
	let base = document;
	for (const predecessor of predecessors) base = reverseDocumentChange(base, predecessor);
	const final = changes.length
		? applyDocumentChange(base, prepareDocumentChange(base, changes, id))
		: base;
	const transition = captureDocumentDifference(document, final, id);
	// Validate the net patch before exposing it to the transactional writer.
	const applied = applyDocumentChange(document, transition);
	if (!same(applied.blocks, final.blocks))
		throw new DocumentChangeConflict('The wording transition could not be applied exactly.');
	return transition;
}
