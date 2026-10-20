import type {
	Concession,
	Instructions,
	PlaybookItem,
	PlaybookItemId,
	PlaybookItemRecord,
	SourceRange
} from './model';
import { newTriggerId } from './model';
import { instructionsFields } from './instructions-fields';
import { canonicalMarks } from '../contract/marks';
import { canonicalNumberPattern } from '../contract/number-pattern';

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
}: Concession): Concession {
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
							...(atom.suffixLevels !== undefined ? { suffixLevels: atom.suffixLevels } : {}),
							...(atom.display
								? {
										display: {
											start: canonicalNumberPattern(atom.display.start),
											...(atom.display.end !== undefined
												? { end: canonicalNumberPattern(atom.display.end) }
												: {}),
											...(atom.display.separator !== undefined
												? { separator: atom.display.separator }
												: {})
										}
									}
								: {}),
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

/** Strip UI keys while preserving all stored instruction strings, including empty strings. */
export function semanticPlaybookDraft(draft: PlaybookItem): PlaybookItem {
	const instructions: Instructions = {};
	for (const { key } of instructionsFields) {
		const text = draft.instructions?.[key];
		if (text !== undefined) instructions[key] = text;
	}
	return {
		triggers: draft.triggers.map(({ id, range }) => ({ id, range: semanticRange(range) })),
		...(Object.keys(instructions).length ? { instructions } : {}),
		concessions: draft.concessions.map(semanticConcession)
	};
}

export function equalPlaybookDraft(a: PlaybookItem, b: PlaybookItem): boolean {
	return JSON.stringify(semanticPlaybookDraft(a)) === JSON.stringify(semanticPlaybookDraft(b));
}

/** Saved editing always exposes every instruction field, even when persistence omits them. */
export function editingPlaybookDraft(record: PlaybookItemRecord): PlaybookDraft {
	const draft = semanticPlaybookDraft(record);
	return { ...draft, instructions: draft.instructions ?? {}, persistedId: record._id };
}

export function newPlaybookDraft(range: SourceRange): PlaybookDraft {
	return {
		instructions: {},
		triggers: [{ id: newTriggerId(), range: semanticRange(range) }],
		concessions: []
	};
}
