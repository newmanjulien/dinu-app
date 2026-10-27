import type { Concession, Instructions, PlaybookItem, PlaybookItemId, SourceRange } from './model';
import { newTriggerId } from './model';
import { instructionsFields } from './instructions-fields';
import { canonicalMarks } from '../contract/marks';
import { canonicalNumberPattern } from '../contract/number-pattern';

export type DeepReadonly<T> = T extends string | number | boolean | null | undefined
	? T
	: T extends object
		? { readonly [K in keyof T]: DeepReadonly<T[K]> }
		: T;
export type ReadonlyDraft = DeepReadonly<PlaybookDraft>;

/** Already frozen values are shared without walking their contents again. */
export function immutable<T extends object>(value: T): T {
	if (Object.isFrozen(value)) return value;
	for (const child of Object.values(value))
		if (child && typeof child === 'object') immutable(child);
	return Object.freeze(value);
}

export type PlaybookDraft = PlaybookItem & {
	instructions: Instructions;
	persistedId?: PlaybookItemId;
};

function semanticRange({ start, end }: SourceRange): SourceRange {
	return {
		start: { sourceKey: start.sourceKey, offset: start.offset },
		end: { sourceKey: end.sourceKey, offset: end.offset }
	};
}

/** Explicit field selection strips nested UI keys, without normalizing text. */
export function semanticConcession({
	id,
	tier,
	description,
	detail,
	after,
	changes
}: DeepReadonly<Concession>): Concession {
	return {
		id,
		tier,
		description,
		...(detail !== undefined ? { detail: [...detail] } : {}),
		...(after !== undefined ? { after } : {}),
		changes: changes.map(({ range, replacement }) => ({
			range: semanticRange(range),
			replacement: replacement.map((atom) => {
				const marks = canonicalMarks(atom.marks);
				return atom.kind === 'text'
					? { kind: 'text', text: atom.text, ...(marks ? { marks } : {}) }
					: {
							kind: 'reference',
							targetItemKey: atom.targetItemKey,
							display: {
								start: canonicalNumberPattern(atom.display.start),
								...(atom.display.end !== undefined
									? { end: canonicalNumberPattern(atom.display.end) }
									: {}),
								...(atom.display.separator !== undefined
									? { separator: atom.display.separator }
									: {})
							},
							...(atom.endTargetItemKey !== undefined
								? { endTargetItemKey: atom.endTargetItemKey }
								: {}),
							...(marks ? { marks } : {})
						};
			})
		}))
	};
}

/** Compare ordered business content independently of metadata and object key order. */
export function equalConcession(a: Concession, b: Concession): boolean {
	return JSON.stringify(semanticConcession(a)) === JSON.stringify(semanticConcession(b));
}

export function equalPlaybookStructure(a: PlaybookItem, b: PlaybookItem): boolean {
	const triggers = (item: PlaybookItem) =>
		item.triggers.map(({ id, range }) => ({ id, range: semanticRange(range) }));
	return (
		JSON.stringify(triggers(a)) === JSON.stringify(triggers(b)) &&
		a.concessions.length === b.concessions.length &&
		a.concessions.every((concession, i) => equalConcession(concession, b.concessions[i]))
	);
}

/** Preserve stored instruction strings, including empty strings, without UI keys. */
export function semanticInstructions(
	value: DeepReadonly<Instructions> | undefined
): Pick<PlaybookItem, 'instructions'> {
	const instructions: Instructions = {};
	for (const { key } of instructionsFields) {
		const text = value?.[key];
		if (text !== undefined) instructions[key] = text;
	}
	return Object.keys(instructions).length ? { instructions } : {};
}

/** Strip UI keys without normalizing business text. */
export function semanticPlaybookDraft(draft: DeepReadonly<PlaybookItem>): PlaybookItem {
	return {
		triggers: draft.triggers.map(({ id, range }) => ({ id, range: semanticRange(range) })),
		...semanticInstructions(draft.instructions),
		concessions: draft.concessions.map(semanticConcession)
	};
}

export function newPlaybookDraft(range: SourceRange): PlaybookDraft {
	return {
		instructions: {},
		triggers: [{ id: newTriggerId(), range: semanticRange(range) }],
		concessions: []
	};
}
