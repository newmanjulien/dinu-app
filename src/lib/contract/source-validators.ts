import { v } from 'convex/values';

// Literal text and counters stay distinct, including Word punctuation after %1.
const numberPattern = v.array(
	v.union(
		v.object({ text: v.string() }),
		v.object({
			level: v.number(),
			case: v.optional(v.union(v.literal('upper'), v.literal('lower'))),
			minimumDigits: v.optional(v.number())
		})
	)
);

// Immutable source coordinates, inline atoms, and baseline blocks.
export const sourcePoint = v.object({ sourceKey: v.string(), offset: v.number() });
export const sourceRange = v.object({ start: sourcePoint, end: sourcePoint });
// Source text and the structural edge after a block have distinct targets.
export const sourceTarget = v.union(
	v.object({ kind: v.literal('text'), range: sourceRange }),
	v.object({ kind: v.literal('boundary'), afterBlockKey: v.string() })
);
const referenceFields = {
	kind: v.literal('reference'),
	targetItemKey: v.string(),
	endTargetItemKey: v.optional(v.string()),
	// Templates preserve the author's punctuation and casing while targets renumber.
	display: v.object({
		start: numberPattern,
		end: v.optional(numberPattern),
		separator: v.optional(v.string())
	})
};
// Canonical contract content is text, references, and structural boundaries; inline formatting is unsupported.
export const replacementAtom = v.union(
	v.object({ kind: v.literal('text'), text: v.string() }),
	v.object(referenceFields),
	// A paragraph boundary is structural, never a newline embedded in an inline atom.
	v.object({ kind: v.literal('paragraph-break') })
);
export const inlineSource = v.union(
	v.object({
		kind: v.literal('text'),
		sourceKey: v.string(),
		text: v.string()
	}),
	v.object({ ...referenceFields, sourceKey: v.string() })
);
export const sourceNumbering = v.object({
	itemKey: v.string(),
	sequenceKey: v.string(),
	parentItemKey: v.optional(v.string()),
	// Section labels do not donate their number sequence to inserted body paragraphs.
	continueSequence: v.optional(v.literal(false)),
	start: v.optional(v.number()),
	labelPattern: numberPattern,
	referencePattern: v.optional(numberPattern),
	minimumDigits: v.optional(v.number()),
	alphabeticStyle: v.optional(v.union(v.literal('sequential'), v.literal('repeated'))),
	style: v.union(
		v.literal('decimal'),
		v.literal('lower-alpha'),
		v.literal('lower-roman'),
		v.literal('upper-alpha'),
		v.literal('upper-roman')
	)
});
const base = { blockKey: v.string(), order: v.number() };
export const sourceTable = v.object({
	...base,
	kind: v.literal('table'),
	variant: v.optional(v.literal('signature')),
	headerRowCount: v.number(),
	rows: v.array(v.array(v.string()))
});
export const paragraphRole = v.union(v.literal('title'), v.literal('heading'), v.literal('body'));
export const roleAssignment = v.object({ blockKey: v.string(), role: paragraphRole });
export const baselineBlock = v.union(
	v.object({
		...base,
		numbering: v.optional(sourceNumbering),
		kind: v.literal('paragraph'),
		role: paragraphRole,
		anchor: v.optional(v.string()),
		content: v.array(inlineSource)
	}),
	sourceTable
);
