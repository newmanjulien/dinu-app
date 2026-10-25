import type { ReplacementAtom } from '../../../contract/source-model';
import { numberAddresses, referenceText, type Address } from '../../../contract/numbering';
import type { Block, Bookmark, Paragraph } from './document';
import type { Issue } from './format';
import { validateNumberPattern, type NumberPatternPart } from '../../../contract/number-pattern';
import { PlaybookValidationError } from '../../../playbook/validation-error';
import { equalMarks } from '../../../contract/marks';
import { addressKey, labelTokens, numberSyntax, numberToken } from './labels';
type Replacement = {
	start: number;
	end: number;
	atom: Extract<ReplacementAtom, { kind: 'reference' }>;
};

function reproducesReference(
	atom: Replacement['atom'],
	addresses: ReadonlyMap<string, Address>,
	text: string
): boolean {
	try {
		return referenceText(atom, addresses) === text;
	} catch (cause) {
		if (!(cause instanceof PlaybookValidationError)) throw cause;
		return false;
	}
}

function displayPattern(text: string, values: readonly string[]): NumberPatternPart[] | undefined {
	if (!text || text.length > 80 || /[^ A-Za-z0-9.()[\]{}:;,–—-]/u.test(text)) return undefined;
	const parts = labelTokens(text);
	if (!parts.length || parts.length > values.length) return undefined;
	const result: NumberPatternPart[] = [];
	let cursor = 0;
	for (const [index, part] of parts.entries()) {
		const level = values.length - parts.length + index + 1,
			value = values[level - 1];
		if (
			part.value.toLowerCase() !== value.toLowerCase() &&
			(!/^\d+$/u.test(part.value) || Number(part.value) !== Number(value))
		)
			return undefined;
		if (part.index > cursor) result.push({ text: text.slice(cursor, part.index) });
		result.push({
			level,
			...(/^\d+$/u.test(part.value)
				? { minimumDigits: Math.min(9, part.value.length) }
				: {
						case: part.value === part.value.toUpperCase() ? ('upper' as const) : ('lower' as const)
					})
		});
		cursor = part.index + part.value.length;
	}
	if (cursor < text.length) result.push({ text: text.slice(cursor) });
	return result;
}

/** Match authored literals before interpreting cached counter case or padding. */
function fieldDisplayPattern(text: string, address: Address): NumberPatternPart[] | undefined {
	if (!text || text.length > 80) return undefined;
	const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
	const pattern = address.pattern;
	const expression = pattern
		.map((part) => {
			if ('text' in part) return escape(part.text);
			const value = address.tokens[part.level - 1];
			return /^\d+$/u.test(value)
				? `(0*${String(Number(value))})`
				: `(${[...value].map((letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`).join('')})`;
		})
		.join('');
	const prefix = text.match(/^(?:Article|Section|Clause|Part)\s+/iu)?.[0] ?? '';
	for (const extra of ['', prefix]) {
		const match = text.slice(extra.length).match(new RegExp(`^${expression}$`, 'u'));
		if (!match) continue;
		let index = 1;
		const result: NumberPatternPart[] = [
			...(extra ? [{ text: extra }] : []),
			...pattern.map((part) => {
				if ('text' in part) return { ...part };
				const value = match[index++];
				return {
					level: part.level,
					...(/^\d+$/u.test(value)
						? { minimumDigits: Math.min(9, value.length) }
						: { case: value === value.toUpperCase() ? ('upper' as const) : ('lower' as const) })
				};
			})
		];
		try {
			validateNumberPattern(result, address.tokens.length, true);
			return result;
		} catch (cause) {
			if (!(cause instanceof PlaybookValidationError)) throw cause;
			return undefined;
		}
	}
	// Ordinary numbering still permits the established punctuation variants.
	const literals = pattern
		.filter((part) => 'text' in part)
		.map((part) => part.text)
		.join('')
		.replace(/^(?:Article|Section|Clause|Part)\s+/iu, '');
	return /[A-Za-z0-9]/u.test(literals) ? undefined : displayPattern(text, address.tokens);
}

export function resolveReferences(
	blocks: Block[],
	paragraphs: Paragraph[],
	bookmarks: Map<string, Bookmark>,
	issue: Issue
) {
	let addresses: ReturnType<typeof numberAddresses>;
	try {
		addresses = numberAddresses(blocks);
	} catch (error) {
		issue('Document', error instanceof Error ? error.message : 'Repair clause numbering in Word.');
		return;
	}
	const agreementTargets = new Map<string, string | null>();
	const targets = new Map<string, Map<string, string | null>>([['agreement', agreementTargets]]);
	const foldedTargets = new Map<string, Map<string, string | null>>();
	const byParagraph = new Map<Paragraph, Block>();
	const byKey = new Map(blocks.map((b) => [b.blockKey, b]));
	const namedScopes = new Map<string, string | null>();
	for (const block of blocks) {
		if (block.kind === 'table') continue;
		const title = block.paragraph.plain
			.trim()
			.match(/^(?:EXHIBIT|SCHEDULE|APPENDIX)\s+[A-Z0-9]+$/iu)?.[0];
		if (title) {
			const name = title.toUpperCase().replace(/\s+/gu, ' ');
			namedScopes.set(name, namedScopes.has(name) ? null : block.blockKey);
		}
	}
	for (const block of blocks)
		if (block.kind !== 'table') {
			byParagraph.set(block.paragraph, block);
			const address = addresses.get(block.blockKey);
			if (!address) continue;
			const scope = block.paragraph.scope ?? 'agreement';
			let local = targets.get(scope);
			if (!local) targets.set(scope, (local = new Map()));
			const key = addressKey(address.address);
			local.set(key, local.has(key) ? null : block.blockKey);
		}
	for (const [scope, local] of targets) {
		const folded = new Map<string, string | null>();
		for (const [address, target] of local) {
			const key = address.toLowerCase();
			folded.set(key, folded.has(key) ? null : target);
		}
		foldedTargets.set(scope, folded);
	}

	const siblingAddresses = new Map<string, Map<string, string[]>>();
	let listFormatter: Intl.ListFormat | undefined;
	for (const [scope, local] of targets) {
		const siblings = new Map<string, string[]>();
		for (const [address, target] of local) {
			if (!target) continue;
			const slash = address.lastIndexOf('/');
			if (slash < 0) continue;
			const parent = address.slice(0, slash);
			let labels = siblings.get(parent);
			if (!labels) siblings.set(parent, (labels = []));
			if (labels.length < 8) labels.push(`“${addresses.get(target)!.address}”`);
		}
		siblingAddresses.set(scope, siblings);
	}
	for (const paragraph of paragraphs) {
		const replacements: Replacement[] = [];
		const fields = paragraph.fields.sort((a, b) => a.start - b.start);
		for (const field of fields) {
			const instruction = field.instruction.trim();
			if (/^HYPERLINK\b/i.test(instruction)) {
				issue(paragraph.location, 'Hyperlinks are preserved as ordinary text.', 'warning');
				continue;
			}
			const ref = instruction.match(
				/^REF\s+(?:"([^"]+)"|([^\s\\]+))\s*((?:\\(?:w|n|h)\s*|\\\*\s+MERGEFORMAT\s*)*)$/i
			);
			if (!ref) {
				issue(
					paragraph.location,
					'Use a full clause-number REF field with supported switches, or replace this Word field with ordinary text.'
				);
				continue;
			}
			const bookmark = bookmarks.get(ref[1] ?? ref[2]);
			const block = bookmark ? byParagraph.get(bookmark.paragraph) : undefined;
			const address = block ? addresses.get(block.blockKey) : undefined;
			const switches = ref[3].toLowerCase();
			const numberSwitch = /\\[wn]\b/.test(switches);
			const fullParagraph =
				bookmark?.start === 0 && bookmark.end === bookmark.paragraph.plain.length;
			const typedLabel =
				bookmark &&
				bookmark.paragraph.trim > 0 &&
				bookmark.start === 0 &&
				bookmark.end !== undefined &&
				bookmark.end <= bookmark.paragraph.trim &&
				bookmark.end >= bookmark.paragraph.plain.slice(0, bookmark.paragraph.trim).trimEnd().length;
			const automaticLabel =
				bookmark?.start === 0 && bookmark.end === 0 && Boolean(bookmark.paragraph.number);
			const cached = paragraph.plain.slice(field.start, field.end);
			const pattern =
				address && addressKey(cached, true) === addressKey(address.address, true)
					? fieldDisplayPattern(cached, address)
					: undefined;
			if (
				!bookmark ||
				!block ||
				!address ||
				bookmark.end === undefined ||
				!(numberSwitch ? fullParagraph || typedLabel || automaticLabel : typedLabel) ||
				(/\\n\b/.test(switches) && block.numbering?.parentItemKey) ||
				!pattern ||
				!reproducesReference(
					{ kind: 'reference', targetItemKey: block.blockKey, display: { start: pattern } },
					addresses,
					cached
				) ||
				field.start === field.end
			) {
				issue(
					paragraph.location,
					'Repair this cross-reference: its bookmark, switches, and displayed full clause number must identify the same numbered clause.'
				);
				continue;
			}
			replacements.push({
				start: field.start,
				end: field.end,
				atom: { kind: 'reference', targetItemKey: block.blockKey, display: { start: pattern } }
			});
		}
		const fieldReplacements = new Map(replacements.map((r) => [r.start, r]));
		let fieldIndex = 0;
		for (const group of referenceGroups(paragraph.plain, fieldReplacements)) {
			if (group.start < paragraph.trim) continue;
			const selected: Replacement[] = [];
			const qualifier = group.qualifier;
			const scope = qualifier
				? /^(?:Agreement|Contract)$/iu.test(qualifier)
					? 'agreement'
					: namedScopes.get(qualifier.toUpperCase().replace(/\s+/gu, ' '))
				: (paragraph.scope ?? 'agreement');
			let previous = '',
				invalid = group.invalid || !scope;
			let reason = group.invalid
				? 'This reference group uses an incomplete or conflicting range.'
				: !scope
					? `The named ${qualifier ?? 'section'} could not be identified uniquely.`
					: '';
			const lookup = (value: string) => {
				const key = addressKey(value);
				const local = scope ? targets.get(scope) : undefined;
				if (local?.has(key)) return local.get(key);
				const folded = scope ? foldedTargets.get(scope) : undefined;
				if (folded?.has(key.toLowerCase())) return folded.get(key.toLowerCase());
				if (!qualifier && /^\d/u.test(key))
					return agreementTargets.has(key)
						? agreementTargets.get(key)
						: foldedTargets.get('agreement')?.get(key.toLowerCase());
				return undefined;
			};
			const missing = (label: string, target: string | null | undefined) => {
				if (target === null)
					return `More than one clause matches “${label}”. Add the full clause number and, if needed, the exhibit or schedule name to distinguish the target.`;
				const key = addressKey(label),
					parent = key.slice(0, key.lastIndexOf('/'));
				const alternatives = parent
					? [
							...(siblingAddresses.get(scope ?? '')?.get(parent) ?? []),
							...(!qualifier && scope !== 'agreement'
								? (siblingAddresses.get('agreement')?.get(parent) ?? [])
								: [])
						]
					: [];
				return `There is no clause numbered “${label}”.${alternatives.length ? ` The existing clauses are ${(listFormatter ??= new Intl.ListFormat('en')).format([...new Set(alternatives)].slice(0, 8))}.` : ''} Check which clause you intended to refer to.`;
			};
			for (let i = 0; i < group.tokens.length && !invalid; i++) {
				const token = group.tokens[i];
				while (fieldIndex < fields.length && fields[fieldIndex].end <= token.start) fieldIndex++;
				const field = fields[fieldIndex];
				const overlap = field && field.start < token.end && field.end > token.start;
				// A field owns only its own span. Other addresses in this group still resolve.
				if (overlap) {
					const resolved = fieldReplacements.get(field.start);
					if (
						!resolved ||
						token.start !== field.start ||
						token.end !== field.end ||
						token.range ||
						group.tokens[i - 1]?.range
					) {
						invalid = true;
						reason = 'This Word field overlaps an incomplete clause reference.';
					} else previous = addresses.get(resolved.atom.targetItemKey)!.address;
					continue;
				}
				const label = expandLabel(token.label, previous);
				const end = token.range ? group.tokens[++i] : undefined;
				const endLabel = end ? expandLabel(end.label, label) : undefined;
				if (
					[label, ...(endLabel ? [endLabel] : [])].some(
						(value) => !labelTokens(value).every((part) => numberToken(part.value))
					)
				) {
					invalid = true;
					reason = 'Clause counters must be between 1 and 10000.';
					break;
				}
				if (end)
					while (fieldIndex < fields.length && fields[fieldIndex].end <= end.start) fieldIndex++;
				const endField = fields[fieldIndex];
				if (end && endField && endField.start < end.end && endField.end > end.start) {
					invalid = true;
					reason = 'This Word field overlaps an incomplete clause reference.';
					break;
				}
				const target = lookup(label);
				const endTarget = endLabel ? lookup(endLabel) : undefined;
				if (!target || (token.range && (!endTarget || end?.range))) {
					invalid = true;
					reason = !target
						? missing(label, target)
						: end?.range
							? 'A reference range must have one start and one end.'
							: missing(endLabel ?? '', endTarget);
					break;
				}
				if (endTarget) {
					const first = byKey.get(target);
					const last = byKey.get(endTarget);
					if (
						!first ||
						!last ||
						first.order >= last.order ||
						first.numbering?.sequenceKey !== last.numbering?.sequenceKey ||
						first.numbering?.parentItemKey !== last.numbering?.parentItemKey
					) {
						invalid = true;
						reason = 'The range must run forward through clauses at the same numbering level.';
						break;
					}
				}
				const startPattern = displayPattern(token.label, addresses.get(target)!.tokens),
					endPattern =
						endTarget && end
							? displayPattern(end.label, addresses.get(endTarget)!.tokens)
							: undefined;
				if (!startPattern || (endTarget && !endPattern)) {
					invalid = true;
					reason = 'We couldn’t preserve this reference’s numbering format.';
					break;
				}
				if (endTarget && end && token.connector) {
					const before = paragraph.plain.slice(token.end, token.connector.start);
					const after = paragraph.plain.slice(token.connector.end, end.start);
					if (before) startPattern.push({ text: before });
					if (after) endPattern!.unshift({ text: after });
				}
				const atom: Replacement['atom'] = {
					kind: 'reference',
					targetItemKey: target,
					...(endTarget ? { endTargetItemKey: endTarget } : {}),
					display: {
						start: startPattern,
						...(endTarget && end
							? {
									end: endPattern!,
									separator: paragraph.plain.slice(token.connector!.start, token.connector!.end)
								}
							: {})
					}
				};
				const stop = end?.end ?? token.end;
				// Match flexibly, but always reproduce the author's displayed text.
				if (!reproducesReference(atom, addresses, paragraph.plain.slice(token.start, stop))) {
					invalid = true;
					reason = 'We couldn’t preserve this reference’s spelling and punctuation.';
					break;
				}
				selected.push({ start: token.start, end: stop, atom });
				previous = endLabel ?? label;
			}
			if (invalid)
				issue(
					paragraph.location,
					`The reference “${paragraph.plain.slice(group.start, group.end)}” needs correcting. ${reason}`
				);
			else replacements.push(...selected);
		}
		paragraph.content = replaceSpans(paragraph, replacements, issue);
	}
}

const expandLabel = (label: string, previous: string) => {
	if (!/^[([]/u.test(label)) return label;
	const count = (label.match(/[([]/g) ?? []).length;
	const groups = [...previous.matchAll(/\([a-zA-Z0-9]+\)|\[[a-zA-Z0-9]+\]/g)];
	return groups.length >= count
		? previous.slice(0, groups[groups.length - count].index) + label
		: previous + label;
};
type Token = {
	label: string;
	start: number;
	end: number;
	range?: boolean;
	connector?: { start: number; end: number };
};
type Group = { start: number; end: number; tokens: Token[]; invalid: boolean; qualifier?: string };

/** Recognition uses syntax and prose boundaries, independently of target existence. */
function readAddress(text: string, continuation = false): string | undefined {
	const base = text.match(
		/^(?:\d+(?:[ \t]*\.[ \t]*\d+)*|[A-Za-z]+|\([A-Za-z0-9]+\)|\[[A-Za-z0-9]+\])/u
	)?.[0];
	if (!base || !labelTokens(base).every(({ value }) => numberSyntax(value))) return undefined;
	const bareAlpha = /^[A-Za-z]+$/u.test(base);
	if (bareAlpha && /^(?:and|or|of|in|to|by|as|at|on|for|is)$/u.test(base)) return undefined;
	const followingProse = /^[ \t]+(?!and\b|or\b|of\b|in\b)[\p{L}]/iu.test(text.slice(base.length));
	if (bareAlpha && followingProse && continuation) return undefined;
	let result = base;
	while (result.length < 80) {
		const group = text
			.slice(result.length)
			.match(/^[ \t]*(?:\(([A-Za-z0-9]+)\)|\[([A-Za-z0-9]+)\])/u);
		if (!group || !numberSyntax(group[1] ?? group[2])) break;
		result += group[0];
	}
	return result;
}

function titleEnd(text: string, cursor: number): number {
	const start = cursor + (text.slice(cursor).match(/^[ \t]+/u)?.[0].length ?? 0);
	if (text[start] !== '(') return cursor;
	let balance = 0;
	for (let stop = start; stop < text.length && stop - start < 4096; stop++) {
		if (text[stop] === '(') balance++;
		if (text[stop] === ')' && --balance === 0)
			return numberSyntax(text.slice(start + 1, stop)) ? cursor : stop + 1;
	}
	return cursor;
}

/** Parse the entire connected group before selecting its scope or resolving targets. */
function* referenceGroups(
	text: string,
	fields: ReadonlyMap<number, Replacement>
): Generator<Group> {
	const headings = /\b(?:Sections?|Clauses?|Articles?|Parts?)\s+/giu;
	const fieldSpans = [...fields.values()];
	let fieldIndex = 0;
	let consumed = 0;
	for (const match of text.matchAll(headings)) {
		if (match.index < consumed) continue;
		while (fieldIndex < fieldSpans.length && fieldSpans[fieldIndex].end <= match.index)
			fieldIndex++;
		const field = fieldSpans[fieldIndex];
		// A heading within a cached field belongs to the field's complete span.
		const insideField = field && field.start <= match.index;
		const start = insideField ? field.start : match.index;
		let cursor = insideField ? start : match.index + match[0].length;
		const tokens: Token[] = [];
		let invalid = false;
		while (tokens.length < 1000) {
			const known = fields.get(cursor);
			const address = known ? text.slice(cursor, known.end) : readAddress(text.slice(cursor));
			if (!address) break;
			const token: Token = { label: address, start: cursor, end: cursor + address.length };
			if (
				/[\p{L}\p{N}]/u.test(text[token.end] ?? '') ||
				/^[([]\d/u.test(text.slice(token.end)) ||
				/^\.\d/u.test(text.slice(token.end))
			)
				invalid = true;
			tokens.push(token);
			cursor = titleEnd(text, token.end);
			const connector = text
				.slice(cursor)
				.match(/^[ \t]*(?:[-–—]|,(?:[ \t]*(?:and|or)\b)?|\b(?:and|or)\b)[ \t]*/iu);
			if (!connector) break;
			let following = cursor + connector[0].length;
			const repeated = fields.has(following)
				? undefined
				: text.slice(following).match(/^(?:Sections?|Clauses?|Articles?|Parts?)\s+/iu);
			if (repeated) following += repeated[0].length;
			const range = /^\s*[-–—]\s*$/u.test(connector[0]);
			const nextField = fields.get(following);
			const continued = nextField
				? text.slice(following, nextField.end)
				: readAddress(text.slice(following), !repeated);
			if (!continued) {
				// A dash before ordinary prose is punctuation, not a malformed range.
				if (range && /^(?:\d|[([])/u.test(text.slice(following))) {
					invalid = true;
					cursor = following;
				}
				break;
			}
			token.range = range;
			if (range) token.connector = { start: cursor, end: cursor + connector[0].length };
			cursor = following;
		}
		if (!tokens.length) continue;
		if (tokens.length === 1000) invalid = true;
		const qualifier = text
			.slice(cursor, cursor + 100)
			.match(
				/^[ \t]+(?:of|in)\s+(?:the\s+)?(Agreement|Contract|(?:Exhibit|Schedule|Appendix)\s+[A-Z0-9]+)\b/iu
			);
		const end = Math.max(cursor, tokens.at(-1)!.end);
		consumed = qualifier ? cursor + qualifier[0].length : end;
		yield {
			start,
			end,
			tokens,
			invalid,
			...(qualifier ? { qualifier: qualifier[1] } : {})
		};
	}
}

/** One ordered sweep through runs and replacements; keys are assigned after it. */
function replaceSpans(
	paragraph: Paragraph,
	replacements: Replacement[],
	issue: Issue
): ReplacementAtom[] {
	replacements.sort((a, b) => a.start - b.start);
	const result: ReplacementAtom[] = [];
	let runIndex = 0,
		runStart = 0,
		cursor = 0;
	function take(end: number): ReplacementAtom[] {
		const atoms: ReplacementAtom[] = [];
		while (cursor < end && runIndex < paragraph.content.length) {
			const run = paragraph.content[runIndex];
			if (run.kind !== 'text') throw new Error('References must resolve from original Word text.');
			const runEnd = runStart + run.text.length;
			if (runEnd <= cursor) {
				runStart = runEnd;
				runIndex++;
				continue;
			}
			const stop = Math.min(end, runEnd);
			atoms.push({ ...run, text: run.text.slice(cursor - runStart, stop - runStart) });
			cursor = stop;
			if (cursor === runEnd) {
				runStart = runEnd;
				runIndex++;
			}
		}
		return atoms;
	}
	take(paragraph.trim);
	for (const replacement of replacements) {
		if (replacement.start < cursor || replacement.end <= replacement.start) {
			issue(paragraph.location, 'Repair overlapping clause references in Word.');
			continue;
		}
		for (const atom of take(replacement.start)) result.push(atom);
		const selected = take(replacement.end);
		const marks = selected[0]?.marks;
		if (!selected.length || selected.some((run) => !equalMarks(run.marks, marks))) {
			issue(
				paragraph.location,
				'Use consistent bold and italic formatting throughout this clause reference in Word.'
			);
			for (const atom of selected) result.push(atom);
		} else result.push({ ...replacement.atom, ...(marks ? { marks } : {}) });
	}
	for (const atom of take(paragraph.plain.length)) result.push(atom);
	return result.length ? result : [{ kind: 'text', text: '' }];
}
