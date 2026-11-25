import type {
	ApprovalPolicy,
	Concession,
	Instructions,
	TemplateAudience,
	TemplateItem,
	TextTrigger
} from './model';
import type { CompiledDocument } from '../document/compiled-document';
import { immutable, type DeepReadonly } from '../immutable';
import {
	equalConcession,
	semanticApprovalPolicy,
	semanticConcession,
	semanticInstructions,
	semanticRepInstruction,
	semanticTarget
} from './content';
import { type TemplateDraft, type ReadonlyDraft } from './draft';
import { GeometryError } from './geometry';
import type { PlaybookGeometryIndex } from './geometry-index';
import { instructionKeys, isRepItem } from './model';
import type { TemplateItemRecord } from './structure';
import { geometrySelectionIssue, selectionIssueMessage } from './source-picking';
import {
	MAX_DOCUMENT_BLOCKS,
	MAX_PLAYBOOK_ITEMS,
	PlaybookValidationError,
	validateChangeReferences,
	validateTemplateItemContent
} from './validation';

export type ConcessionDraft = {
	originalConcession: DeepReadonly<Concession>;
	concession: Concession;
	affectsOtherParts: boolean;
};
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
		| { audience: 'rep'; instructions: Instructions; approvalPolicy: ApprovalPolicy }
		| { audience: 'buyer'; explanation: string }
	>()!;
	trigger = $state.raw<DeepReadonly<TemplateDraft['trigger']>>()!;
	concessions = $state.raw<DeepReadonly<Concession[]>>([]);
	concessionDraft = $state<ConcessionDraft | null>(null);
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
	private validateGeometry = $derived(this.geometry?.createDraftValidator() ?? null);
	private validateComposerGeometry = $derived(this.geometry?.createDraftValidator() ?? null);

	constructor(
		draft: DeepReadonly<TemplateDraft>,
		confirmed: DeepReadonly<TemplateItemRecord> | null,
		readonly audience: TemplateAudience
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
	}
	// The draft owns source locations; highlighting is a projection of that structure.
	initialSelection = $derived(
		!this.confirmed || Boolean(this.concessionDraft) ? this.trigger.target : null
	);
	private buyerTrigger: DeepReadonly<TextTrigger> | null = $derived.by(() => {
		if (this.content.audience !== 'buyer') return null;
		if (this.trigger.target.kind !== 'text')
			throw new Error('Buyer explanations require selected text.');
		return { id: this.trigger.id, target: this.trigger.target };
	});
	private normalizedBuyerTrigger = $derived(
		this.buyerTrigger
			? immutable({
					id: this.buyerTrigger.id,
					target: semanticTarget(this.buyerTrigger.target)
				})
			: null
	);
	draft: ReadonlyDraft = $derived(
		this.content.audience === 'buyer'
			? {
					audience: 'buyer',
					explanation: this.content.explanation,
					trigger: this.buyerTrigger!,
					...(this.confirmed ? { persistedId: this.confirmed._id } : {})
				}
			: {
					audience: 'rep',
					...(this.confirmed ? { persistedId: this.confirmed._id } : {}),
					instructions: this.content.instructions,
					approvalPolicy: this.content.approvalPolicy,
					trigger: this.trigger,
					concessions: this.concessions
				}
	);
	adoptContent(item: DeepReadonly<TemplateItem>) {
		this.content = isRepItem(item)
			? {
					audience: 'rep',
					instructions: semanticInstructions(item.instructions),
					approvalPolicy: semanticApprovalPolicy(item.approvalPolicy)
				}
			: { audience: 'buyer', explanation: item.explanation };
	}
	private persistedDirty = $derived.by(() => {
		const content = this.content,
			confirmed = this.confirmed;
		if (content.audience === 'buyer') {
			const explanation = content.explanation.trim() ? content.explanation : '';
			return explanation !== (confirmed && !isRepItem(confirmed) ? confirmed.explanation : '');
		}
		const saved = confirmed && isRepItem(confirmed) ? confirmed : null;
		const normalized = semanticInstructions(content.instructions);
		const savedInstructions = saved ? semanticInstructions(saved.instructions) : undefined;
		const approvalPolicy = semanticApprovalPolicy(content.approvalPolicy);
		const savedApprovalPolicy = saved
			? semanticApprovalPolicy(saved.approvalPolicy)
			: { kind: 'none' as const };
		return (
			instructionKeys.some((key) => normalized[key] !== savedInstructions?.[key]) ||
			approvalPolicy.kind !== savedApprovalPolicy.kind ||
			(approvalPolicy.kind === 'required' &&
				savedApprovalPolicy.kind === 'required' &&
				approvalPolicy.instructions !== savedApprovalPolicy.instructions) ||
			this.concessions.length !== (saved?.concessions.length ?? 0) ||
			this.concessions.some((concession, i) => concession.id !== saved?.concessions[i]?.id)
		);
	});
	private compositionDirty = $derived(
		this.concessionDraft
			? !equalConcession(
					this.concessionDraft.concession,
					this.concessionDraft.originalConcession
				) || this.concessionDraft.affectsOtherParts
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
				concessions: this.concessions
			})
		)
	);
	payload: DeepReadonly<TemplateItem> = $derived(
		immutable(
			this.content.audience === 'buyer'
				? {
						audience: 'buyer' as const,
						trigger: this.normalizedBuyerTrigger!,
						explanation: this.content.explanation
					}
				: {
						...this.structure,
						instructions: semanticInstructions(this.content.instructions),
						approvalPolicy: semanticApprovalPolicy(this.content.approvalPolicy)
					}
		)
	);
	private proposedConcessionPayload = $derived(
		this.concessionDraft && this.payload.audience === 'rep'
			? immutable({
					...this.payload,
					concessions: [
						...this.payload.concessions,
						semanticConcession(this.concessionDraft.concession)
					]
				})
			: null
	);
	private contentReason = $derived(
		this.validationReason(() => validateTemplateItemContent(this.payload))
	);
	private proposedConcessionContentReason = $derived(
		this.proposedConcessionPayload
			? this.validationReason(() => validateTemplateItemContent(this.proposedConcessionPayload!))
			: ''
	);
	private referencesReason = $derived(this.references(this.concessions));
	private composerReferencesReason = $derived(
		this.references(this.concessionDraft ? [this.concessionDraft.concession] : [])
	);
	private geometryReason = $derived(this.checkGeometry(this.validateGeometry, this.concessions));
	private composerGeometryReason = $derived(
		this.concessionDraft
			? this.checkGeometry(this.validateComposerGeometry, [this.concessionDraft.concession])
			: ''
	);
	private capacityReason = $derived(this.capacity());
	validation = $derived(
		this.capacityReason || this.contentReason || this.geometryReason || this.referencesReason
	);
	concessionValidation = $derived(
		this.capacityReason ||
			this.proposedConcessionContentReason ||
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
	private checkGeometry(
		validate: ReturnType<PlaybookGeometryIndex['createDraftValidator']> | null,
		concessions: DeepReadonly<Concession[]>
	) {
		if (!validate || !this.geometry) return 'Wait for the template source';
		void this.geometryVersion;
		return this.validationReason(() =>
			validate(this.confirmed?._id, {
				audience: this.audience,
				trigger: this.trigger,
				concessions
			})
		);
	}
}
