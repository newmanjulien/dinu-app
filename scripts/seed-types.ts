import type { NumberPattern } from '../src/lib/document/number-pattern';
import type {
	SourceRange,
	SourceTarget,
	SourceBlock,
	ReplacementAtom,
	ParagraphRole
} from '../src/lib/document/source-model';
import type { AuthoringInstructions } from '../src/lib/playbook/model';
export type LegacyAtom = Infer<typeof atom>;
export type LegacySegment = Infer<typeof segment>;
export type LegacyNumbering = NonNullable<LegacyBlock['numbering']>;
export type LegacyBlock = Infer<typeof legacyBlock>;
export type LegacyConcession = Infer<typeof concession>;
export type LegacyBox = Infer<typeof legacyBox>;
export type LegacyExport = {
	tables: { name: string; [field: string]: unknown }[];
	blocks: LegacyBlock[];
	boxes: LegacyBox[];
	deleted: unknown[];
};
export type WorkingAtom = LegacyAtom | ReplacementAtom;
export type WorkingInline = (LegacyAtom | Exclude<ReplacementAtom, { kind: 'paragraph-break' }>) & {
	sourceKey: string;
};
export type WorkingBlock = {
	kind: 'table' | 'paragraph' | 'heading';
	blockKey: string;
	order: number;
	content: WorkingInline[];
	rows: string[][];
	numbering?: LegacyNumbering & {
		labelPattern?: NumberPattern;
		referencePattern?: NumberPattern;
		alphabeticStyle?: 'sequential';
	};
	role?: ParagraphRole;
	anchor?: string;
	level?: number;
	variant?: 'signature';
	headerRowCount?: number;
	optional?: boolean;
};
export type WorkingChange = {
	range: SourceRange;
	target?: SourceTarget;
	replacement: WorkingAtom[];
};
export type WorkingTrigger = { id: string; range: SourceRange; target?: SourceTarget };
export type WorkingItem = {
	triggers: WorkingTrigger[];
	instructions: AuthoringInstructions;
	concessions: {
		id: string;
		tier: 'preferred' | 'rare';
		description: string;
		detail?: string[];
		after?: string;
		changes: WorkingChange[];
	}[];
};
export type Manifest = {
	blocks: { oldId: string; blockKey: string; virtualInsertion?: SourceTarget }[];
	items: {
		oldId: string;
		clauseKey: string;
		triggerIds: string[];
		coordinatedTriggerIds?: string[];
		authoredLocations?: { concessionId: string; archivedEdits: number[][] }[];
	}[];
	provisions: { key: string; range: SourceRange }[];
};
export type FrozenState = Infer<typeof frozenStates>[number];

// Archived input has its own schema; it intentionally predates modern source validators.
import { v, type Infer } from 'convex/values';
const marks = v.optional(
	v.object({ bold: v.optional(v.boolean()), italic: v.optional(v.boolean()) })
);
const atom = v.union(
	v.object({ kind: v.literal('text'), text: v.string(), marks }),
	v.object({
		kind: v.literal('reference'),
		targetItemKey: v.string(),
		endTargetItemKey: v.optional(v.string()),
		marks
	})
);
const segment = v.object({
	content: v.array(atom),
	clauseKey: v.optional(v.string()),
	occurrenceKey: v.optional(v.string()),
	provisionKey: v.optional(v.string())
});
const blockFields = {
	_id: v.string(),
	_creationTime: v.number(),
	blockKey: v.string(),
	order: v.number(),
	numbering: v.optional(
		v.object({
			itemKey: v.string(),
			sequenceKey: v.string(),
			parentItemKey: v.optional(v.string()),
			style: v.union(
				v.literal('decimal'),
				v.literal('lower-alpha'),
				v.literal('upper-alpha'),
				v.literal('lower-roman'),
				v.literal('upper-roman')
			),
			activationProvisionKey: v.optional(v.string())
		})
	),
	anchor: v.optional(v.string()),
	level: v.optional(v.number())
};
export const legacyBlock = v.union(
	v.object({
		...blockFields,
		kind: v.literal('table'),
		rows: v.array(v.array(v.object({ content: v.array(segment) }))),
		variant: v.optional(v.literal('signature')),
		headerRowCount: v.number()
	}),
	v.object({
		...blockFields,
		kind: v.union(v.literal('paragraph'), v.literal('heading')),
		content: v.array(segment)
	})
);
const concession = v.object({
	concessionKey: v.string(),
	copy: v.object({
		before: v.string(),
		detail: v.array(v.string()),
		after: v.optional(v.string())
	}),
	replacements: v.array(v.object({ targetProvisionKey: v.string(), content: v.array(atom) }))
});
export const legacyBox = v.object({
	_id: v.string(),
	_creationTime: v.number(),
	clauseKey: v.string(),
	summary: v.string(),
	howToExplainToBuyers: v.string(),
	commonObjections: v.string(),
	negotiation: v.string(),
	changesNeedEscalation: v.optional(v.string()),
	preferredConcessions: v.array(concession),
	rareConcessions: v.array(concession)
});

export const frozenStates = v.array(
	v.object({
		name: v.string(),
		selected: v.record(v.string(), v.string()),
		view: v.union(v.literal('effective'), v.literal('redline')),
		sha256: v.string(),
		provenanceSha256: v.string()
	})
);

export type PriorResolvedBlock =
	| Extract<import('../src/lib/document/model').ResolvedBlock, { kind: 'table' }>
	| (Omit<
			Exclude<import('../src/lib/document/model').ResolvedBlock, { kind: 'table' }>,
			'kind' | 'role'
	  > & { kind: 'paragraph' | 'heading'; role?: ParagraphRole; level?: number });
