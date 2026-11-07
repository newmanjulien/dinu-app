import { canonicalNumberPattern } from '../contract/number-pattern';
import { sameReplacementAtom } from '../contract/replacement-content';
import { sameSourceTarget, textTarget } from '../contract/source-model';
import type { DeepReadonly } from '../immutable';
import type {
	AuthoringInstructions,
	Concession,
	Instructions,
	PlaybookItem,
	SourceRange,
	SourceTarget
} from './model';
import { instructionKeys } from './model';

function semanticRange({ start, end }: SourceRange): SourceRange {
	return {
		start: { sourceKey: start.sourceKey, offset: start.offset },
		end: { sourceKey: end.sourceKey, offset: end.offset }
	};
}

export function semanticTarget(target: SourceTarget): SourceTarget {
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
		changes: changes.map(({ target: range, replacement }) => ({
			target: semanticTarget(range),
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
					sameSourceTarget(change.target, b.changes[index]!.target) &&
					change.replacement.length === b.changes[index]!.replacement.length &&
					change.replacement.every((atom, atomIndex) =>
						sameReplacementAtom(atom, b.changes[index]!.replacement[atomIndex]!)
					)
			))
	);
}

/** Preserve stored instruction strings, including empty strings, without UI keys. */
export function semanticInstructions(
	value: DeepReadonly<AuthoringInstructions> | undefined
): Pick<PlaybookItem, 'instructions' | 'approvalPolicy'> {
	const instructions: Instructions = {};
	for (const key of instructionKeys) {
		const text = value?.[key];
		if (text !== undefined) instructions[key] = text;
	}
	const guidance = value?.changesNeedApproval;
	return {
		...(Object.keys(instructions).length ? { instructions } : {}),
		approvalPolicy: guidance?.trim()
			? { kind: 'required', instructions: guidance }
			: { kind: 'none' }
	};
}

/** Strip UI keys without normalizing business text. */
export function semanticPlaybookDraft(
	draft: DeepReadonly<
		Pick<PlaybookItem, 'trigger' | 'concessions'> &
			Partial<Pick<PlaybookItem, 'instructions' | 'approvalPolicy'>>
	>
): PlaybookItem {
	return {
		trigger: { id: draft.trigger.id, target: semanticTarget(draft.trigger.target) },
		...semanticInstructions(draft.instructions),
		...(draft.approvalPolicy
			? {
					approvalPolicy:
						draft.approvalPolicy.kind === 'required'
							? { kind: 'required' as const, instructions: draft.approvalPolicy.instructions }
							: { kind: 'none' as const }
				}
			: {}),
		concessions: draft.concessions.map(semanticConcession)
	};
}
