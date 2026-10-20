import type { BaselineBlock } from '../source-model';
import { numberAddresses } from '../numbering';
import { numberValue, tokenPosition } from '../number-token';
import {
	addressPattern,
	patternKey,
	patternParts,
	shiftNumberPattern,
	validateNumberPattern,
	wordNumberPattern,
	type NumberPatternPart
} from '../number-pattern';
import { child, children, indexBy, val, on, type XmlNode as Node } from './xml';
import type { Block } from './document';
import type { Issue, Location } from './format';
import { equalMarks } from '../marks';
import { addressKey, labelTokens, labelPattern, typedLabel } from './labels';
type Numbering = NonNullable<BaselineBlock['numbering']>;
type Level = {
	style: Numbering['style'];
	pattern: NumberPatternPart[];
	rawPattern: string;
	start: number;
	restart: number;
	props?: Node;
	minimumDigits?: number;
};

export function resolveNumbering(blocks: Block[], root: Node | undefined, issue: Issue) {
	const abstracts = indexBy(children(root, 'abstractNum'), 'abstractNumId');
	const nums = indexBy(children(root, 'num'), 'numId');
	const levelCache = new Map<string, Level | null>();
	function level(numId: string, depth: number, location: Location): Level | undefined {
		const cacheKey = `${numId}:${depth}`;
		if (levelCache.has(cacheKey)) return levelCache.get(cacheKey) ?? undefined;
		const num = nums.get(numId);
		const override = children(num, 'lvlOverride').find((n) => Number(n.attrs.ilvl) === depth);
		const definition =
			child(override, 'lvl') ??
			children(abstracts.get(val(child(num, 'abstractNumId')) ?? ''), 'lvl').find(
				(n) => Number(n.attrs.ilvl) === depth
			);
		const formats: Record<string, Level['style']> = {
			decimal: 'decimal',
			decimalZero: 'decimal',
			lowerLetter: 'lower-alpha',
			upperLetter: 'upper-alpha',
			lowerRoman: 'lower-roman',
			upperRoman: 'upper-roman'
		};
		const style = formats[val(child(definition, 'numFmt')) ?? ''];
		const rawPattern = val(child(definition, 'lvlText')) ?? '';
		const pattern = wordNumberPattern(rawPattern);
		let validPattern = true;
		try {
			validateNumberPattern(pattern, depth + 1, true);
		} catch {
			validPattern = false;
		}
		const start = Number(
			val(child(override, 'startOverride')) ?? val(child(definition, 'start')) ?? 1
		);
		const restart = Number(val(child(definition, 'lvlRestart')) ?? depth);
		if (
			!definition ||
			!style ||
			on(child(definition, 'isLgl')) ||
			depth > 8 ||
			!Number.isSafeInteger(restart) ||
			restart < 0 ||
			restart > depth ||
			!validPattern ||
			!Number.isSafeInteger(start) ||
			start < 1 ||
			start > 10000
		) {
			issue(
				location,
				'This list uses an unsupported numbering format. Use decimal, letter, or Roman numbering with standard punctuation in Word.'
			);
			levelCache.set(cacheKey, null);
			return;
		}
		const result = {
			style,
			pattern,
			rawPattern,
			start,
			restart,
			props: child(definition, 'rPr'),
			...(val(child(definition, 'numFmt')) === 'decimalZero' ? { minimumDigits: 2 } : {})
		};
		levelCache.set(cacheKey, result);
		return result;
	}

	const active = new Map<string, string[]>();
	const counters = new Map<string, (number | undefined)[]>();
	const sequences = new Set<string>();
	const wordValues = new Map<string, string[]>();
	const positions = new Map<string, number>();
	for (const block of blocks) {
		if (block.kind === 'table' || !block.paragraph.number) continue;
		const { id, depth, label } = block.paragraph.number;
		const definition = level(id, depth, block.paragraph.location);
		const parents = active.get(id) ?? [],
			counts = counters.get(id) ?? [];
		if (depth && !parents[depth - 1]) {
			issue(
				block.paragraph.location,
				'This numbered clause has no preceding parent. Repair its list level in Word.'
			);
			continue;
		}
		if (!definition) continue;
		const parentItemKey = depth ? parents[depth - 1] : undefined;
		const position = counts[depth] === undefined ? definition.start : counts[depth]! + 1;
		counts[depth] = position;
		positions.set(block.blockKey, position);
		const values = [
			...(parentItemKey ? wordValues.get(parentItemKey)! : []),
			numberValue(definition.style, position).padStart(definition.minimumDigits ?? 0, '0')
		];
		wordValues.set(block.blockKey, values);
		// Preserve the source label using Word's raw placeholder grammar independently.
		block.paragraph.number!.displayedLabel = definition.rawPattern.replace(
			/%([1-9])/gu,
			(_, n) => values[Number(n) - 1]
		);
		const sequenceKey = `word-${id}-${depth}-${parentItemKey ?? 'root'}`;
		block.numbering = {
			itemKey: block.blockKey,
			sequenceKey,
			style: definition.style,
			...(definition.style.includes('alpha') ? { alphabeticStyle: 'repeated' as const } : {}),
			...(definition.minimumDigits ? { minimumDigits: definition.minimumDigits } : {}),
			marks: label(definition.props),
			labelPattern: definition.pattern,
			...(!sequences.has(sequenceKey) && position !== 1 ? { start: position } : {}),
			...(!parentItemKey ||
			definition.pattern.some((part) => 'level' in part && part.level !== depth + 1)
				? { referencePattern: addressPattern(definition.pattern) }
				: {}),
			...(parentItemKey ? { parentItemKey } : {})
		};
		sequences.add(sequenceKey);
		parents[depth] = block.blockKey;
		parents.length = depth + 1;
		for (let deeper = depth + 1; deeper < counts.length; deeper++) {
			const next = level(id, deeper, block.paragraph.location);
			if (next && next.restart !== 0 && depth < next.restart) counts[deeper] = undefined;
		}
		active.set(id, parents);
		counters.set(id, counts);
	}
	inferHierarchy(blocks, positions, issue);
}

// Word counters produce the displayed labels. Legal parents are resolved in a
// separate pass shared by typed labels and automatic lists.
type Candidate = {
	block: Extract<Block, { kind: 'paragraph' | 'heading' }>;
	label: string;
	token: string;
	prefix: string;
	trim: number;
	style: Numbering['style'];
	position: number;
	pattern: NumberPatternPart[];
	word?: Numbering;
	parent?: Candidate;
	depth: number;
	scope: string;
	sequence: string;
	address: string;
	valid: boolean;
	minimumDigits?: number;
	alphabeticStyle?: Numbering['alphabeticStyle'];
	localPattern: string;
	boundary: string;
};
const alphabeticPosition = (token: string) => tokenPosition(token, 'repeated');
const sequentialPosition = (token: string) => tokenPosition(token, 'sequential');
const romanPosition = (token: string) => tokenPosition(token, 'roman');
function inferHierarchy(blocks: Block[], positions: Map<string, number>, issue: Issue) {
	const candidates: Candidate[] = [];
	const wordAddresses = numberAddresses(blocks);
	let scope = 'agreement',
		boundary = 'agreement';
	for (const block of blocks) {
		if (block.kind === 'table') {
			for (const row of block.rows) for (const cell of row) for (const p of cell) p.scope = scope;
			continue;
		}
		const word = block.numbering;
		const match = !word && !block.paragraph.number ? typedLabel(block.paragraph.plain) : undefined;
		// Exhibit titles need not have a Word Heading style. Each exhibit owns
		// its own local addresses and sequences, including repeated A/B labels.
		if (/^\s*(?:EXHIBIT|SCHEDULE|APPENDIX)\s+[A-Z0-9]+\s*$/iu.test(block.paragraph.plain))
			scope = boundary = block.blockKey;
		else if (block.kind === 'heading' && !word && !match && !block.paragraph.number)
			boundary = block.blockKey;
		block.paragraph.scope = scope;
		if (!word && !match) continue;
		if (match && block.paragraph.fields.some((f) => f.start < match[0].length && f.end > 0))
			continue;
		const label = word ? block.paragraph.number!.displayedLabel! : match![1];
		const tokens = word
			? wordAddresses.get(word.itemKey)!.tokens
			: labelTokens(label).map((m) => m.value);
		const token = tokens.at(-1)!;
		const pattern = word?.labelPattern ? patternParts(word.labelPattern) : labelPattern(label);
		candidates.push({
			block,
			label,
			token,
			scope,
			boundary,
			word,
			...(word?.alphabeticStyle ? { alphabeticStyle: word.alphabeticStyle } : {}),
			prefix: tokens.length > 1 ? addressKey(tokens.slice(0, -1).join('/')) : '',
			trim: match?.[0].length ?? 0,
			pattern,
			localPattern: patternKey(pattern)!,
			...(word?.minimumDigits
				? { minimumDigits: word.minimumDigits }
				: /^0\d+$/u.test(token)
					? { minimumDigits: token.length }
					: {}),
			style:
				word?.style ??
				(/^\d+$/.test(token)
					? 'decimal'
					: token === token.toUpperCase()
						? 'upper-alpha'
						: 'lower-alpha'),
			position: positions.get(block.blockKey) ?? 0,
			depth: 1,
			sequence: '',
			address: '',
			valid: tokens.length > 0
		});
	}
	// Index neighboring candidates by declaration shape rather than scanning the document.
	const shapes = new Map<string, Candidate[]>();
	for (const c of candidates) {
		if (/^\d+$/u.test(c.token)) continue;
		const key = JSON.stringify([
			c.boundary,
			c.prefix,
			c.localPattern,
			c.token === c.token.toUpperCase()
		]);
		let group = shapes.get(key);
		if (!group) shapes.set(key, (group = []));
		group.push(c);
	}
	const previousNeighbor = new Map<Candidate, Candidate>();
	const nextNeighbor = new Map<Candidate, Candidate>();
	const sequentialShapes = new Set<Candidate>();
	for (const group of shapes.values()) {
		// Paragraph indentation is in integral twips. Each bounded neighborhood
		// lookup visits at most 239 keys, regardless of document length.
		for (const [ordered, neighbors] of [
			[group, previousNeighbor],
			[[...group].reverse(), nextNeighbor]
		] as const) {
			const byIndent = new Map<number, Candidate>();
			let latest: Candidate | undefined, unspecified: Candidate | undefined;
			for (const c of ordered) {
				const indent = c.block.paragraph.indent;
				let neighbor = indent === undefined ? latest : unspecified;
				if (indent !== undefined)
					for (let i = Math.floor(indent - 119); i <= Math.ceil(indent + 119); i++) {
						const other = byIndent.get(i);
						if (
							other &&
							(!neighbor ||
								(neighbors === previousNeighbor
									? other.block.order > neighbor.block.order
									: other.block.order < neighbor.block.order))
						)
							neighbor = other;
					}
				if (neighbor) neighbors.set(c, neighbor);
				if (indent === undefined) unspecified = c;
				else byIndent.set(indent, c);
				latest = c;
			}
		}
		const indicators = group.filter(
			(c) => !c.word && !alphabeticPosition(c.token) && !romanPosition(c.token)
		);
		const unindentedIndicator = indicators.some((c) => c.block.paragraph.indent === undefined);
		const indicatorIndents = new Set(indicators.map((c) => c.block.paragraph.indent));
		for (const c of group) {
			const indent = c.block.paragraph.indent;
			let sequential = unindentedIndicator || (indent === undefined && indicators.length > 0);
			if (indent !== undefined && !sequential)
				for (let i = indent - 119; i <= indent + 119 && !sequential; i++)
					sequential = indicatorIndents.has(i);
			if (sequential) sequentialShapes.add(c);
		}
	}
	for (const [index, c] of candidates.entries()) {
		if (c.word) continue;
		if (c.style === 'decimal') {
			c.position = tokenPosition(c.token, 'decimal');
			continue;
		}
		const upper = c.token === c.token.toUpperCase();
		const alpha = alphabeticPosition(c.token) || sequentialPosition(c.token),
			romanValue = romanPosition(c.token);
		const previous = previousNeighbor.get(c),
			next = nextNeighbor.get(c);
		const alphabeticNeighbor =
			(next && (alphabeticPosition(next.token) || sequentialPosition(next.token)) === alpha + 1) ||
			(previous &&
				(alphabeticPosition(previous.token) || sequentialPosition(previous.token)) === alpha - 1 &&
				!previous.style.includes('roman'));
		const isRoman =
			romanValue > 0 &&
			!alphabeticNeighbor &&
			(c.token.length > 1 ||
				(next && romanPosition(next.token) === romanValue + 1) ||
				(previous && previous.style.includes('roman') && previous.position === romanValue - 1) ||
				(c.token.toLowerCase() === 'i' &&
					candidates[index - 1]?.scope === c.scope &&
					candidates[index - 1].style.includes('alpha')));
		if (isRoman) c.style = upper ? 'upper-roman' : 'lower-roman';
		if (!isRoman) c.alphabeticStyle = sequentialShapes.has(c) ? 'sequential' : 'repeated';
		c.position = isRoman
			? romanValue
			: c.alphabeticStyle === 'sequential'
				? sequentialPosition(c.token)
				: alpha;
	}
	const byKey = new Map(candidates.map((c) => [c.block.blockKey, c]));
	const groups = new Map<string, Candidate[]>();
	const latest = new Map<string, string>();
	const stack: Candidate[] = [];
	let currentBoundary = '';
	for (const c of candidates) {
		if (c.boundary !== currentBoundary) {
			stack.length = 0;
			currentBoundary = c.boundary;
		}
		const indent = c.block.paragraph.indent;
		const preceding = stack.at(-1);
		const sibling = stack.findLast(
			(p) =>
				p.style === c.style &&
				p.localPattern === c.localPattern &&
				(indent === undefined ||
					p.block.paragraph.indent === undefined ||
					p.block.kind === 'heading' ||
					(c.word &&
						p.word &&
						c.block.paragraph.number?.id === p.block.paragraph.number?.id &&
						c.block.paragraph.number?.depth === p.block.paragraph.number?.depth) ||
					Math.abs(indent - p.block.paragraph.indent) < 120)
		);
		// Full addresses and Word's ancestors are definitive. Otherwise, indentation
		// and returning to a prior label convention establish siblings; a new
		// convention establishes children, without prescribing a style order.
		c.parent = c.word?.parentItemKey
			? byKey.get(c.word.parentItemKey)
			: c.prefix && !c.word
				? stack.findLast((p) => p.address === c.prefix)
				: sibling
					? sibling.parent
					: indent !== undefined &&
						  preceding?.block.kind !== 'heading' &&
						  preceding?.block.paragraph.indent !== undefined
						? indent <= preceding.block.paragraph.indent + 120
							? preceding.parent
							: (stack.findLast(
									(p) =>
										p.block.kind !== 'heading' &&
										p.block.paragraph.indent !== undefined &&
										p.block.paragraph.indent < indent - 120
								) ?? preceding)
						: stack.at(-1);
		if (
			(c.block.kind === 'heading' || /^(?:Article|Section|Clause|Part)\s/iu.test(c.label)) &&
			!c.prefix &&
			!c.word?.parentItemKey
		)
			c.parent = undefined;
		c.depth = c.parent ? c.parent.depth + 1 : 1;
		const offset = c.word
			? c.depth - (c.block.paragraph.number!.depth + 1)
			: c.prefix
				? 0
				: c.depth - 1;
		c.pattern = shiftNumberPattern(c.pattern, offset);
		if (c.prefix && !c.word && !c.parent) c.valid = false;
		if (c.parent && c.parent.scope !== c.scope) c.valid = false;
		// Word's repeated lettering and typed sequential lettering are distinct sequences.
		const base = `${c.boundary}:${c.parent?.block.blockKey ?? 'root'}:${c.style}:${c.alphabeticStyle ?? ''}:${patternKey(c.pattern)}`;
		let sequence = latest.get(base) ?? base;
		let group = groups.get(sequence);
		if (group && c.position <= group.at(-1)!.position) {
			sequence = `${base}:restart:${c.block.blockKey}`;
			group = undefined;
		}
		if (!group) groups.set(sequence, (group = []));
		group.push(c);
		latest.set(base, sequence);
		c.sequence = sequence;
		c.address =
			c.prefix || !c.parent ? addressKey(c.label) : c.parent.address + '/' + addressKey(c.label);
		while (stack.length && stack.at(-1)!.depth >= c.depth) stack.pop();
		stack.push(c);
	}
	for (const group of groups.values()) {
		const minimumDigits = Math.max(...group.map((c) => c.minimumDigits ?? 0));
		if (minimumDigits) for (const c of group) c.minimumDigits = minimumDigits;
	}
	const increasingGroups = new Map(
		[...groups].map(([key, group]) => [
			key,
			group.every((m, i) => !i || m.position > group[i - 1].position)
		])
	);
	const previousInSequence = new Map<string, Candidate>();
	for (const c of candidates) {
		const group = groups.get(c.sequence)!;
		const increasing = increasingGroups.get(c.sequence)!;
		c.valid &&=
			c.depth <= 9 &&
			c.pattern.every((part) => 'text' in part || (part.level >= 1 && part.level <= c.depth)) &&
			c.position >= 1 &&
			c.position <= 10000 &&
			(!c.parent || c.parent.valid) &&
			(Boolean(c.word) ||
				(increasing &&
					(group.length >= 2 ||
						Boolean(c.prefix && c.parent) ||
						(Boolean(c.parent) && c.position === 1) ||
						/^(?:Article|Section|Clause|Part)\s/iu.test(c.label))));
		let marks = c.word?.marks;
		if (!c.word) {
			let remaining = c.trim;
			for (const atom of c.block.paragraph.content) {
				if (!remaining || atom.kind !== 'text') break;
				const length = Math.min(atom.text.length, remaining);
				if (atom.text.slice(0, length).trim()) {
					if (marks === undefined) marks = atom.marks ?? {};
					else if (!equalMarks(atom.marks, marks)) c.valid = false;
				}
				remaining -= length;
			}
		}
		if (!c.valid) {
			delete c.block.numbering;
			issue(
				c.block.paragraph.location,
				`We couldn’t tell which clause “${c.label}” belongs under. In Word, use a full clause number (such as 3(a)(i)) or set the correct level in a multilevel list. Keep bold and italic formatting consistent across the clause number.`
			);
			continue;
		}
		const previous = previousInSequence.get(c.sequence);
		previousInSequence.set(c.sequence, c);
		c.block.numbering = {
			itemKey: c.block.blockKey,
			sequenceKey: `import-${c.sequence}`,
			style: c.style,
			...(c.minimumDigits ? { minimumDigits: c.minimumDigits } : {}),
			...(c.alphabeticStyle ? { alphabeticStyle: c.alphabeticStyle } : {}),
			labelPattern: c.pattern,
			marks: marks ?? {},
			...(c.parent ? { parentItemKey: c.parent.block.blockKey } : {}),
			...(!previous || c.position !== previous.position + 1 ? { start: c.position } : {}),
			...((c.prefix && !c.word) ||
			!c.parent ||
			c.pattern.some((part) => 'level' in part && part.level !== c.depth)
				? { referencePattern: addressPattern(c.pattern) }
				: {})
		};
		c.block.paragraph.trim = c.trim;
	}
	// Never accept inference that changes the source's displayed label.
	const resolved = numberAddresses(blocks);
	for (const c of candidates)
		if (c.valid && resolved.get(c.block.blockKey)?.label !== c.label)
			issue(
				c.block.paragraph.location,
				`The clause label “${c.label}” cannot be preserved. Repair its numbering in Word.`
			);
}
