import type { CompiledContract } from '../contract/compiled-contract';
import { immutable } from '../immutable';
import { equalConcession, semanticInstructions, semanticPlaybookDraft } from './content';
import { type PlaybookDraft, type ReadonlyDraft } from './draft';
import { GeometryError } from './geometry';
import type { PlaybookGeometryIndex } from './geometry-index';
import type { AuthoringInstructions, Concession, PlaybookItemRecord } from './model';
import { authoringInstructionKeys, authoringInstructions } from './model';
import { geometrySelectionIssue, selectionIssueMessage } from './source-picking';
import {
	MAX_CONTRACT_BLOCKS,
	MAX_PLAYBOOK_ITEMS,
	PlaybookValidationError,
	validateChangeReferences,
	validateConcessions,
	validatePlaybookItemContent
} from './validation';

type Composition = {
	baseline: Concession;
	concession: Concession;
	step: 'concession' | 'other-part';
	affectsOtherParts: boolean;
};
export type Workflow =
	| { kind: 'editing' }
	| { kind: 'creating-explanation' }
	| ({ kind: 'creating-concession' } & Composition)
	| ({ kind: 'adding-concession'; triggerId: string } & Composition);
export type OperationState = { kind: 'editing' } | { kind: 'missing' };

function validationReason(check: () => void): string {
	try {
		check();
		return '';
	} catch (error) {
		if (error instanceof GeometryError) return selectionIssueMessage(geometrySelectionIssue(error));
		if (error instanceof PlaybookValidationError) return error.message;
		return "Couldn't validate these instructions. Please try again.";
	}
}

/** State and projections only. The controller owns every mutation and lifecycle decision. */
export class AuthoringContext {
	confirmed = $state.raw<PlaybookItemRecord | null>(null);
	remote = $state.raw<PlaybookItemRecord | null>(null);
	instructions: AuthoringInstructions = $state({});
	trigger = $state.raw<PlaybookDraft['trigger']>()!;
	concessions = $state.raw<Concession[]>([]);
	workflow: Workflow = $state({ kind: 'editing' });
	operation = $state.raw<OperationState>({ kind: 'editing' });
	selectedAnnotationId = $state<string | null>(null);
	previewConcessionId = $state<string | null>(null);
	// Absence only proves deletion after the query has observed the highest known contentRevision.
	queryRevision = 0;
	queryPresent: boolean | null = null;
	contract = $state.raw<CompiledContract | null>(null);
	geometry = $state.raw<PlaybookGeometryIndex | null>(null);
	geometryVersion = $state(0);
	itemCount = $state(0);
	validateGeometry: ReturnType<PlaybookGeometryIndex['createDraftValidator']> | null = null;

	constructor(draft: PlaybookDraft, confirmed: PlaybookItemRecord | null, workflow: Workflow) {
		this.confirmed = this.remote = confirmed ? immutable(confirmed) : null;
		// An existing editor opens from the domain's previously accepted query record.
		this.queryRevision = confirmed?.contentRevision ?? 0;
		this.instructions = authoringInstructions(draft);
		this.trigger = immutable(confirmed?.trigger ?? draft.trigger);
		this.concessions = immutable(confirmed?.concessions ?? draft.concessions);
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
	draft: ReadonlyDraft = $derived({
		...(this.confirmed ? { persistedId: this.confirmed._id } : {}),
		instructions: this.instructions,
		approvalPolicy: semanticInstructions(this.instructions).approvalPolicy,
		trigger: this.trigger,
		concessions: this.concessions
	});
	private persistedDirty = $derived(
		authoringInstructionKeys.some(
			(key) =>
				(this.instructions[key] ?? '') !==
				((this.confirmed ? authoringInstructions(this.confirmed)[key] : '') ?? '')
		) ||
			this.concessions.length !== (this.confirmed?.concessions.length ?? 0) ||
			this.concessions.some((concession, i) => concession.id !== this.confirmed?.concessions[i]?.id)
	);
	private compositionDirty = $derived(
		this.workflow.kind === 'creating-concession' || this.workflow.kind === 'adding-concession'
			? !equalConcession(this.workflow.concession, this.workflow.baseline) ||
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
	// Normalization follows structure changes; typing instructions shares the frozen structure.
	private structure = $derived(
		immutable(
			semanticPlaybookDraft({
				trigger: this.trigger,
				concessions:
					this.workflow.kind === 'creating-concession'
						? [this.workflow.concession]
						: this.concessions
			})
		)
	);
	payload = $derived(immutable({ ...this.structure, ...semanticInstructions(this.instructions) }));
	private stagedPayload = $derived(
		this.workflow.kind === 'creating-concession'
			? this.structure
			: this.composer
				? immutable(semanticPlaybookDraft({ trigger: this.trigger, concessions: [this.composer] }))
				: null
	);
	private composerLimitReason = $derived(
		this.composer ? validationReason(() => validateConcessions([this.composer!])) : ''
	);
	private contentReason = $derived(
		validationReason(() => validatePlaybookItemContent(this.payload))
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
			? validationReason(() => {
					validatePlaybookItemContent(this.stagedPayload!);
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
		if (!this.contract || !this.geometry) return 'Wait for the contract source';
		if (this.contract.blocks.length > MAX_CONTRACT_BLOCKS)
			return 'Contract exceeds the supported source or Playbook size';
		void this.geometryVersion;
		return this.itemCount -
			(this.confirmed && this.geometry.items.has(this.confirmed._id) ? 1 : 0) >=
			MAX_PLAYBOOK_ITEMS
			? 'Playbook exceeds supported size'
			: '';
	}
	private references(concessions: Concession[]) {
		return this.contract
			? validationReason(() =>
					validateChangeReferences(this.contract!, {
						concessions
					})
				)
			: 'Wait for the contract source';
	}
	private checkGeometry(concessions: Concession[]) {
		if (!this.validateGeometry || !this.geometry) return 'Wait for the contract source';
		void this.geometryVersion;
		return validationReason(() =>
			this.validateGeometry!(this.confirmed?._id, {
				trigger: this.trigger,
				concessions
			})
		);
	}
}
