import type {
	Concession,
	Instructions,
	PlaybookItem,
	PlaybookItemId,
	SourceRange,
	SourceTarget
} from './model';
import { newTriggerId } from './model';
import { instructionsFields } from './instructions-fields';
import { canonicalNumberPattern } from '../contract/number-pattern';
import { sameSourceTarget, textTarget } from '../contract/source-model';
import { sameReplacementAtom } from '../contract/replacement-content';

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

function semanticTarget(target: SourceTarget): SourceTarget {
	return target.kind === 'boundary'
		? { kind: 'boundary', afterBlockKey: target.afterBlockKey }
		: textTarget(semanticRange(target.range));
}

/** Explicit field selection strips nested UI keys, without normalizing text. */
export function semanticConcession({
	id,
	tier,
	description,
	changes
}: DeepReadonly<Concession>): Concession {
	return {
		id,
		tier,
		description,
		changes: changes.map(({ range, replacement }) => ({
			range: semanticTarget(range),
			replacement: replacement.map((atom) => {
				if (atom.kind === 'paragraph-break') return { kind: 'paragraph-break' as const };
				return atom.kind === 'text'
					? { kind: 'text', text: atom.text }
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
								: {})
						};
			})
		}))
	};
}

/** Compare ordered business content without allocating normalized copies. */
export function equalConcession(a: Concession, b: Concession): boolean {
	return (
		a === b ||
		(a.id === b.id &&
			a.tier === b.tier &&
			a.description === b.description &&
			a.changes.length === b.changes.length &&
			a.changes.every(
				(change, index) =>
					sameSourceTarget(change.range, b.changes[index]!.range) &&
					change.replacement.length === b.changes[index]!.replacement.length &&
					change.replacement.every((atom, atomIndex) =>
						sameReplacementAtom(atom, b.changes[index]!.replacement[atomIndex]!)
					)
			))
	);
}

export function equalPlaybookStructure(a: PlaybookItem, b: PlaybookItem): boolean {
	const trigger = (item: PlaybookItem) => ({
		id: item.trigger.id,
		range: semanticTarget(item.trigger.range)
	});
	return (
		JSON.stringify(trigger(a)) === JSON.stringify(trigger(b)) &&
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
		trigger: { id: draft.trigger.id, range: semanticTarget(draft.trigger.range) },
		...semanticInstructions(draft.instructions),
		concessions: draft.concessions.map(semanticConcession)
	};
}

export function newPlaybookDraft(range: SourceTarget): PlaybookDraft {
	return {
		instructions: {},
		trigger: { id: newTriggerId(), range: semanticTarget(range) },
		concessions: []
	};
}
