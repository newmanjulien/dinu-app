import type { TemplateAudience } from './model';
import type { CompiledDocument } from '../document/compiled-document';
import { immutable, type DeepReadonly } from '../immutable';
import {
	equalConcession,
	semanticInstructions,
	semanticRepInstruction,
	semanticTarget
} from './content';
import { type TemplateDraft, type ReadonlyDraft } from './draft';
import { GeometryError } from './geometry';
import type { PlaybookGeometryIndex } from './geometry-index';
import type { AuthoringInstructions, Concession, TemplateItem } from './model';
import { authoringInstructionKeys, authoringInstructions, isRepItem } from './model';
import type { TemplateItemRecord } from './structure';
import { geometrySelectionIssue, selectionIssueMessage } from './source-picking';
import {
	MAX_DOCUMENT_BLOCKS,
	MAX_PLAYBOOK_ITEMS,
	PlaybookValidationError,
	validateChangeReferences,
	validateConcessions,
	validateTemplateItemContent
} from './validation';

type Composition = {
	originalConcession: DeepReadonly<Concession>;
	concession: Concession;
	step: 'concession' | 'other-part';
	affectsOtherParts: boolean;
};
export type Workflow =
	| { kind: 'editing' }
	| { kind: 'creating-item' }
	| ({ kind: 'creating-concession' } & Composition)
	| ({ kind: 'adding-concession'; triggerId: string } & Composition);
export type OperationState = { kind: 'editing' } | { kind: 'missing' };

/** State and projections only. The controller owns every mutation and lifecycle decision. */
export class AuthoringContext {
	private validationReason(check: () => void): string {
		try {
			check();
			return '';
		} catch (error) {
			if (error instanceof GeometryError)
				return selectionIssueMessage(geometrySelectionIssue(error), this.audience);
			if (error instanceof PlaybookValidationError) return error.message;
			return "Couldn't validate this content. Please try again.";
		}
	}
	confirmed = $state.raw<DeepReadonly<TemplateItemRecord> | null>(null);
	remote = $state.raw<DeepReadonly<TemplateItemRecord> | null>(null);
	content = $state<
		| { audience: 'rep'; instructions: AuthoringInstructions }
		| { audience: 'buyer'; explanation: string }
	>()!;
	trigger = $state.raw<DeepReadonly<TemplateDraft['trigger']>>()!;
	concessions = $state.raw<DeepReadonly<Concession[]>>([]);
	workflow: Workflow = $state({ kind: 'editing' });
	operation = $state.raw<OperationState>({ kind: 'editing' });
	selectedAnnotationId = $state<string | null>(null);
	previewConcessionId = $state<string | null>(null);
	// Absence only proves deletion after the query has observed the highest known contentRevision.
	queryRevision = 0;
	queryPresent: boolean | null = null;
	document = $state.raw<CompiledDocument | null>(null);
	geometry = $state.raw<PlaybookGeometryIndex | null>(null);
	geometryVersion = $state(0);
	itemCount = $state(0);
	validateGeometry: ReturnType<PlaybookGeometryIndex['createDraftValidator']> | null = null;

	constructor(
		draft: DeepReadonly<TemplateDraft>,
		confirmed: DeepReadonly<TemplateItemRecord> | null,
		workflow: Workflow,
		readonly audience: TemplateAudience = 'rep'
	) {
		this.confirmed = this.remote = confirmed ? immutable(confirmed) : null;
		// An existing editor opens from the domain's previously accepted query record.
		this.queryRevision = confirmed?.contentRevision ?? 0;
		this.adoptContent(draft);
		this.trigger = immutable(confirmed?.trigger ?? draft.trigger);
		this.concessions = immutable(
			isRepItem(draft)
				? confirmed && isRepItem(confirmed)
					? confirmed.concessions
					: draft.concessions
				: []
		);
		this.workflow = workflow;
	}
	composer = $derived(
		this.workflow.kind === 'creating-concession' || this.workflow.kind === 'adding-concession'
			? this.workflow.concession
			: undefined
	);
	// The draft owns source locations; highlighting is a projection of that structure.
	initialSelection = $derived(
		this.workflow.kind === 'editing'
			? null
			: (this.composer?.changes[0]?.target ?? this.trigger.target ?? null)
	);
	draft: ReadonlyDraft = $derived(
		this.content.audience === 'buyer'
			? {
					audience: 'buyer',
					explanation: this.content.explanation,
					trigger: this.trigger,
					...(this.confirmed ? { persistedId: this.confirmed._id } : {})
				}
			: {
					...(this.confirmed ? { persistedId: this.confirmed._id } : {}),
					instructions: this.content.instructions,
					approvalPolicy: semanticInstructions(this.content.instructions).approvalPolicy,
					trigger: this.trigger,
					concessions: this.concessions
				}
	);
	adoptContent(item: DeepReadonly<TemplateItem>) {
		this.content = isRepItem(item)
			? { audience: 'rep', instructions: authoringInstructions(item) }
			: { audience: 'buyer', explanation: item.explanation };
	}
	private persistedDirty = $derived.by(() => {
		const content = this.content,
			confirmed = this.confirmed;
		if (content.audience === 'buyer')
			return (
				content.explanation !== (confirmed && !isRepItem(confirmed) ? confirmed.explanation : '')
			);
		const saved = confirmed && isRepItem(confirmed) ? confirmed : null;
		return (
			authoringInstructionKeys.some(
				(key) =>
					(content.instructions[key] ?? '') !==
					((saved ? authoringInstructions(saved)[key] : '') ?? '')
			) ||
			this.concessions.length !== (saved?.concessions.length ?? 0) ||
			this.concessions.some((concession, i) => concession.id !== saved?.concessions[i]?.id)
		);
	});
	private compositionDirty = $derived(
		this.workflow.kind === 'creating-concession' || this.workflow.kind === 'adding-concession'
			? !equalConcession(this.workflow.concession, this.workflow.originalConcession) ||
					this.workflow.affectsOtherParts
			: false
	);
	dirty = $derived(this.persistedDirty || this.compositionDirty);
	get hasPersistedChanges() {
		return this.persistedDirty;
	}
	get hasCompositionChanges() {
		return this.compositionDirty;
	}
	// Normalization follows structure changes; typing shares the frozen structure.
	private structure = $derived(
		immutable(
			semanticRepInstruction({
				trigger: this.trigger,
				concessions:
					this.workflow.kind === 'creating-concession'
						? [this.workflow.concession]
						: this.concessions
			})
		)
	);
	private normalizedTrigger = $derived(
		immutable({
			id: this.trigger.id,
			target: semanticTarget(this.trigger.target)
		})
	);
	payload: DeepReadonly<TemplateItem> = $derived(
		immutable(
			this.content.audience === 'buyer'
				? {
						audience: 'buyer' as const,
						trigger: this.normalizedTrigger,
						explanation: this.content.explanation
					}
				: { ...this.structure, ...semanticInstructions(this.content.instructions) }
		)
	);
	private stagedPayload = $derived(
		this.workflow.kind === 'creating-concession'
			? this.structure
			: this.composer
				? immutable(semanticRepInstruction({ trigger: this.trigger, concessions: [this.composer] }))
				: null
	);
	private composerLimitReason = $derived(
		this.composer ? this.validationReason(() => validateConcessions([this.composer!])) : ''
	);
	private contentReason = $derived(
		this.validationReason(() => validateTemplateItemContent(this.payload))
	);
	private referencesReason = $derived(this.references(this.concessions));
	private composerReferencesReason = $derived(
		this.references(this.composer ? [this.composer] : [])
	);
	private geometryReason = $derived(this.checkGeometry(this.concessions));
	private composerGeometryReason = $derived(
		this.composer ? this.checkGeometry([this.composer]) : ''
	);
	private capacityReason = $derived(this.capacity());
	private stagedContentReason = $derived(
		this.stagedPayload
			? this.validationReason(() => {
					validateTemplateItemContent(this.stagedPayload!);
				})
			: ''
	);
	validation = $derived(
		this.capacityReason ||
			this.contentReason ||
			this.geometryReason ||
			this.referencesReason ||
			(this.workflow.kind === 'creating-concession'
				? this.composerGeometryReason || this.composerReferencesReason || this.composerLimitReason
				: '')
	);
	additionValidation = $derived(
		this.capacityReason ||
			this.composerLimitReason ||
			this.stagedContentReason ||
			this.composerGeometryReason ||
			this.composerReferencesReason
	);
	private capacity() {
		if (!this.document || !this.geometry) return 'Wait for the template source';
		if (this.document.blocks.length > MAX_DOCUMENT_BLOCKS)
			return 'Template exceeds the supported source or content size';
		void this.geometryVersion;
		return this.itemCount -
			(this.confirmed && this.geometry.items.has(this.confirmed._id) ? 1 : 0) >=
			MAX_PLAYBOOK_ITEMS
			? 'Template exceeds supported size'
			: '';
	}
	private references(concessions: DeepReadonly<Concession[]>) {
		return this.document
			? this.validationReason(() =>
					validateChangeReferences(this.document!, {
						concessions
					})
				)
			: 'Wait for the template source';
	}
	private checkGeometry(concessions: DeepReadonly<Concession[]>) {
		if (!this.validateGeometry || !this.geometry) return 'Wait for the template source';
		void this.geometryVersion;
		return this.validationReason(() =>
			this.validateGeometry!(this.confirmed?._id, {
				trigger: this.trigger,
				concessions
			})
		);
	}
}
