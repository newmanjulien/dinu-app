import type { CompiledContract } from '../contract/compiled-contract';
import type { PlaybookGeometryIndex } from './geometry-index';
import type { Concession, Instructions, PlaybookItemRecord } from './model';
import {
	immutable,
	semanticInstructions,
	semanticPlaybookDraft,
	type PlaybookDraft,
	type ReadonlyDraft
} from './draft';
import { instructionsFields } from './instructions-fields';
import { GeometryError } from './geometry';
import { geometrySelectionIssue, selectionIssueMessage } from './source-picking';
import {
	validatePlaybookItemContent,
	validateChangeReferences,
	validateNewConcessions,
	PlaybookValidationError,
	MAX_PLAYBOOK_ITEMS,
	MAX_CONTRACT_BLOCKS
} from './validation';
import type { Operation } from './save-transport';
import type { SourceRange } from './model';

type Composition = {
	concession: Concession;
	step: 'concession' | 'other-part';
	affectsOtherParts: boolean;
};
export type Workflow =
	| { kind: 'editing' }
	| { kind: 'creating-explanation' }
	| ({ kind: 'creating-concession' } & Composition)
	| ({ kind: 'adding-concession'; triggerId: string } & Composition);
export type OperationState =
	| { kind: 'editing' }
	| { kind: 'saving'; operation: Operation }
	| { kind: 'uncertain'; operation: Operation; message: string }
	| { kind: 'rejected'; operation: Operation; message: string }
	| { kind: 'missing' };

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
	instructions: Instructions = $state({});
	triggers = $state.raw<PlaybookDraft['triggers']>([]);
	concessions = $state.raw<Concession[]>([]);
	workflow: Workflow = $state({ kind: 'editing' });
	operation = $state.raw<OperationState>({ kind: 'editing' });
	selectedTriggerId = $state<string | null>(null);
	selectedAnnotationId = $state<string | null>(null);
	initialSelection = $state<SourceRange | null>(null);
	previewConcessionId = $state<string | null>(null);
	// Absence only proves deletion after the query has observed the highest known revision.
	queryRevision = 0;
	queryPresent: boolean | null = null;
	attempt: object | null = null;
	contract = $state.raw<CompiledContract | null>(null);
	geometry = $state.raw<PlaybookGeometryIndex | null>(null);
	geometryVersion = $state(0);
	itemCount = $state(0);
	validateGeometry: ReturnType<PlaybookGeometryIndex['createDraftValidator']> | null = null;

	constructor(draft: PlaybookDraft, confirmed: PlaybookItemRecord | null, workflow: Workflow) {
		this.confirmed = this.remote = confirmed ? immutable(confirmed) : null;
		// An existing editor opens from the domain's previously accepted query record.
		this.queryRevision = confirmed?.revision ?? 0;
		this.instructions = { ...draft.instructions };
		this.triggers = immutable(confirmed?.triggers ?? draft.triggers);
		this.concessions = immutable(confirmed?.concessions ?? draft.concessions);
		this.workflow = workflow;
	}
	composer = $derived(
		this.workflow.kind === 'creating-concession' || this.workflow.kind === 'adding-concession'
			? this.workflow.concession
			: undefined
	);
	draft: ReadonlyDraft = $derived({
		...(this.confirmed ? { persistedId: this.confirmed._id } : {}),
		instructions: this.instructions,
		triggers: this.triggers,
		concessions: this.concessions
	});
	dirty = $derived(
		instructionsFields.some(
			({ key }) => (this.instructions[key] ?? '') !== (this.confirmed?.instructions?.[key] ?? '')
		) ||
			this.concessions.length !== (this.confirmed?.concessions.length ?? 0) ||
			this.concessions.some((concession, i) => concession.id !== this.confirmed?.concessions[i]?.id)
	);
	// Normalization follows structure changes; typing instructions shares the frozen structure.
	private structure = $derived(
		immutable(
			semanticPlaybookDraft({
				triggers: this.triggers,
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
				? immutable(
						semanticPlaybookDraft({ triggers: this.triggers, concessions: [this.composer] })
					)
				: null
	);
	private composerLimitReason = $derived(
		this.composer ? validationReason(() => validateNewConcessions([this.composer!])) : ''
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
	rejectedSaveReason = $derived(
		this.operation.kind === 'rejected' &&
			this.operation.operation.kind === 'save' &&
			JSON.stringify(this.payload) === JSON.stringify(this.operation.operation.request.item)
			? this.operation.message
			: ''
	);
	private capacity() {
		if (!this.contract || !this.geometry) return 'Wait for the contract source';
		if (this.contract.blocks.length > MAX_CONTRACT_BLOCKS)
			return 'Contract exceeds the supported source or Playbook size';
		const operation = this.operation;
		if (
			(operation.kind === 'saving' || operation.kind === 'uncertain') &&
			operation.operation.kind === 'save' &&
			!operation.operation.request.id
		)
			return '';
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
						triggers: [],
						concessions
					})
				)
			: 'Wait for the contract source';
	}
	private checkGeometry(concessions: Concession[]) {
		if (!this.validateGeometry || !this.geometry) return 'Wait for the contract source';
		void this.geometryVersion;
		const operation = this.operation;
		const isolated =
			(operation.kind === 'saving' || operation.kind === 'uncertain') &&
			operation.operation.kind === 'save' &&
			!operation.operation.request.id;
		return validationReason(() =>
			this.validateGeometry!(
				this.confirmed?._id,
				{
					triggers: this.triggers,
					concessions
				},
				isolated
			)
		);
	}
}
