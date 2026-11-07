import type { BreakPolicyContext, SelectionCandidate } from '../document/selection/selection-model';
import type { CompiledContract } from '../contract/compiled-contract';
import type { Address } from '../contract/numbering';
import { targetContainers } from '../contract/ranges';
import { createReferenceCatalog, type ReferenceCatalog } from '../contract/reference-catalog';
import { hasMeaningfulReplacement } from '../contract/replacement-content';
import { sameSourceTarget, type ReplacementAtom } from '../contract/source-model';
import { countStartupWork } from '../document/runtime/render-perf';
import { immutable, type DeepReadonly } from '../immutable';
import { AuthoringContext, type Workflow } from './authoring-context.svelte';
import { semanticConcession } from './content';
import { triggerAnnotationId } from './document-overlay';
import { newPlaybookDraft, type PlaybookDraft } from './draft';
import type { PlaybookGeometryIndex } from './geometry-index';
import {
	authoringInstructions,
	newConcessionId,
	type AuthoringInstructions,
	type Concession,
	type PlaybookItemRecord,
	type SourceTarget
} from './model';
import type { Operation } from './save-transport';
import {
	evaluateConcessionAddition,
	evaluateInitialSelection,
	evaluateSecondarySelection,
	selectionIssueMessage,
	type AuthoringMode,
	type SelectionAvailability,
	type SelectionEligibility,
	type SelectionIssue
} from './source-picking';

export type AuthoringSource = {
	selectionContext?: BreakPolicyContext;
	contract: CompiledContract | null;
	geometry: PlaybookGeometryIndex | null;
	items: readonly { _id: string }[] | null;
	available: boolean;
	editingAvailable?: boolean;
	editingUnavailableReason?: string;
	itemsCurrent: boolean;
	addresses?: ReadonlyMap<string, Address>;
	lookup: (id: string) => {
		record: PlaybookItemRecord;
		annotations: readonly import('./document-overlay').DocumentAnnotation[];
	} | null;
	detailStatus?: (id: string) => 'present' | 'missing' | 'loading';
};
export type AuthoringRecovery = {
	item: import('./model').PlaybookItem;
};
export type AuthoringTransition =
	| { kind: 'switch-item'; itemId: string }
	| { kind: 'start' }
	| { kind: 'attach-secondary' }
	| { kind: 'start-addition' }
	| { kind: 'cancel' }
	| { kind: 'leave' };
export type TransitionDecision =
	| { kind: 'allowed' }
	| { kind: 'blocked'; message: string }
	| { kind: 'confirm-discard'; message: string };
export type AuthoringOutcome = 'retained' | 'closed';
export type TextSelectionPurpose = 'new-item' | 'secondary-location';

/** Route-attached draft commands and source validation. The workspace owns submitted work. */
export class AuthoringController {
	private context = $state.raw<AuthoringContext | null>(null);
	private issue = $state<SelectionIssue | null>(null);
	private warning = $state('');
	private referenceCatalogCache:
		| {
				index: CompiledContract['index'] | undefined;
				addresses: ReadonlyMap<string, Address> | undefined;
				catalog: ReferenceCatalog;
		  }
		| undefined;
	constructor(
		private source: () => AuthoringSource,
		private submission: {
			readonly available: boolean;
			readonly reason: string;
			submit(operation: Operation, recovery: AuthoringRecovery): boolean;
		}
	) {}
	get entry(): object | null {
		return this.context;
	}
	get draft() {
		return this.context?.draft ?? null;
	}
	private get workflow() {
		return this.context?.workflow;
	}
	get creating() {
		return Boolean(this.workflow && this.workflow.kind !== 'editing');
	}
	get addingConcession() {
		return this.workflow?.kind === 'adding-concession';
	}
	get step() {
		return this.workflow && 'step' in this.workflow ? this.workflow.step : 'concession';
	}
	get affectsOtherParts() {
		return this.workflow && 'affectsOtherParts' in this.workflow
			? this.workflow.affectsOtherParts
			: false;
	}
	get selectedAnnotationId() {
		return this.context?.selectedAnnotationId ?? null;
	}
	get previewConcessionId() {
		return this.context?.previewConcessionId ?? null;
	}
	private get composing() {
		return this.workflow?.kind !== 'editing' && Boolean(this.context);
	}
	get dirty() {
		return this.context?.dirty ?? false;
	}
	get hasUnsavedWork() {
		return this.dirty;
	}
	private currentPhase = $derived.by(() => {
		const context = this.context;
		if (!context) return undefined;
		if (
			context.operation.kind !== 'missing' &&
			context.remote &&
			(!context.confirmed || context.remote.contentRevision > context.confirmed.contentRevision) &&
			(this.dirty || this.composing)
		)
			return { kind: 'conflict' as const, remote: context.remote };
		return context.operation;
	});
	get phase(): DeepReadonly<typeof this.currentPhase> {
		return this.currentPhase;
	}
	get canEdit() {
		const source = this.source();
		const id = this.context?.confirmed?._id;
		return (
			(source.editingAvailable ?? source.available) &&
			source.itemsCurrent &&
			(!id || !source.detailStatus || source.detailStatus(id) === 'present') &&
			this.phase?.kind === 'editing'
		);
	}
	private get editingUnavailableReason() {
		if (this.statusMessage) return this.statusMessage;
		const source = this.source();
		if (source.editingUnavailableReason) return source.editingUnavailableReason;
		if (!source.itemsCurrent) return 'Refreshing instructions…';
		const id = this.context?.confirmed?._id;
		if (id && source.detailStatus) {
			const status = source.detailStatus(id);
			if (status === 'loading') return 'Loading these instructions…';
			if (status === 'missing')
				return 'These instructions are no longer available. Cancel and select the clause again.';
		}
		return 'Instruction editing is temporarily unavailable.';
	}
	get canCancel() {
		return Boolean(this.context);
	}
	get canDelete() {
		return (
			!this.creating &&
			Boolean(this.context?.confirmed) &&
			this.canEdit &&
			this.submission.available
		);
	}
	get statusMessage() {
		const phase = this.phase;
		switch (phase?.kind) {
			case 'conflict':
				return 'This instruction box changed elsewhere. Your local edits are retained.';
			case 'missing':
				return 'This instruction box was deleted elsewhere. Cancel to dismiss your local draft.';
			default:
				return '';
		}
	}
	get creationConcession(): DeepReadonly<Concession> | undefined {
		return this.context?.composer;
	}
	get stagedCreation() {
		return this.creating && Boolean(this.creationConcession);
	}
	get secondarySelection() {
		return this.creationConcession?.changes[1]?.target;
	}
	get otherClauseActive() {
		return this.stagedCreation && this.step === 'other-part';
	}
	get pickingSecondaryLocation() {
		return (
			this.otherClauseActive &&
			this.canEdit &&
			!this.additionTargetReason &&
			!this.secondarySelection
		);
	}
	get locationPicking() {
		return this.pickingSecondaryLocation;
	}
	get textSelectionPurpose(): TextSelectionPurpose | null {
		if (!this.source().available) return null;
		if (this.pickingSecondaryLocation) return 'secondary-location';
		if (!this.context) return 'new-item';
		return null;
	}
	get textSelectionEnabled() {
		return this.textSelectionPurpose !== null;
	}
	get textSelectionAutoConfirm() {
		return this.textSelectionPurpose !== 'new-item';
	}
	get referenceCatalog() {
		const source = this.source();
		const index = source.contract?.index;
		const addresses = source.addresses ?? index?.addresses;
		const cached = this.referenceCatalogCache;
		if (cached && cached.index === index && cached.addresses === addresses) return cached.catalog;
		const catalog = createReferenceCatalog(index, addresses);
		this.referenceCatalogCache = { index, addresses, catalog };
		return catalog;
	}
	get selectedRanges() {
		return [this.context?.initialSelection, this.secondarySelection].filter(
			(range): range is SourceTarget => Boolean(range)
		);
	}
	get additionTargetReason() {
		const workflow = this.workflow;
		if (workflow?.kind !== 'adding-concession') return '';
		const context = this.context!;
		const reason = !context.confirmed
			? 'This instruction box is no longer available'
			: !this.canEdit
				? this.statusMessage
				: '';
		if (reason) return reason;
		const range = context.trigger.id === workflow.triggerId ? context.trigger.target : undefined;
		const captured = workflow.concession.changes[0].target;
		if (!range || !sameSourceTarget(range, captured))
			return 'This instruction box or its selected text changed. Cancel and start the addition again.';
		return '';
	}
	get feedback() {
		return this.warning || (this.issue ? selectionIssueMessage(this.issue) : '');
	}
	get lastStep() {
		return this.step === 'other-part' || !this.affectsOtherParts;
	}
	get canCancelLocation() {
		return this.canEdit && this.stagedCreation && this.step === 'other-part';
	}
	get creationIncomplete() {
		return Boolean(this.creationIncompleteReason);
	}
	private get creationIncompleteReason() {
		const concession = this.creationConcession;
		if (!concession) return '';
		if (!concession.description.trim()) return 'Describe the concession before continuing.';
		if (!hasMeaningfulReplacement(concession.changes[0].replacement))
			return 'Add replacement text before continuing.';
		if (this.otherClauseActive && !this.secondarySelection)
			return 'Select the other part of the contract before saving.';
		return '';
	}
	private currentPrimaryAction = $derived.by(() => {
		const context = this.context;
		const action =
			this.stagedCreation && !this.lastStep ? 'advance' : this.addingConcession ? 'add' : 'save';
		const validation =
			!context || !this.canEdit
				? ''
				: this.additionTargetReason ||
					(this.addingConcession ? context.additionValidation : context.validation);
		const reason = !context
			? ''
			: !this.canEdit
				? this.editingUnavailableReason
				: validation ||
					(action === 'save' && !this.submission.available ? this.submission.reason : '') ||
					this.creationIncompleteReason ||
					(action === 'save' && !this.creating && !this.dirty ? 'No changes to save.' : '');
		const label = action === 'advance' ? 'Add the other part' : action === 'add' ? 'Add' : 'Save';
		return {
			action,
			label,
			reason,
			isError: Boolean(validation || this.statusMessage),
			disabled:
				!this.canEdit ||
				(action === 'save' && !this.submission.available) ||
				this.creationIncomplete ||
				Boolean(reason) ||
				(action === 'save' && !this.creating && !this.dirty)
		};
	});
	get primaryAction(): Readonly<typeof this.currentPrimaryAction> {
		return this.currentPrimaryAction;
	}
	clearFeedback() {
		this.issue = null;
		this.warning = '';
	}
	reportIssue(issue: SelectionIssue | null) {
		this.warning = '';
		this.issue = issue;
	}
	reportBlocked(message: string) {
		this.issue = null;
		this.warning = message;
	}
	clearPreview() {
		if (this.context) this.context.previewConcessionId = null;
	}

	assess(action: AuthoringTransition): TransitionDecision {
		if (action.kind === 'switch-item' && this.draft?.persistedId === action.itemId)
			return { kind: 'allowed' };
		if (action.kind === 'cancel') return { kind: 'allowed' };
		if (action.kind === 'attach-secondary')
			return this.pickingSecondaryLocation
				? { kind: 'allowed' }
				: {
						kind: 'blocked',
						message: 'Choose the other-part step before selecting another passage.'
					};
		if (action.kind === 'start-addition')
			return !this.creating && this.context?.confirmed && this.canEdit
				? { kind: 'allowed' }
				: {
						kind: 'blocked',
						message:
							'Finish or cancel the current operation or creation before adding a concession.'
					};
		if (action.kind === 'leave')
			return this.hasUnsavedWork
				? {
						kind: 'confirm-discard',
						message: 'Abandon your unsaved instruction-box changes and leave?'
					}
				: { kind: 'allowed' };
		if (!this.hasUnsavedWork) return { kind: 'allowed' };
		return {
			kind: 'blocked',
			message: this.unsavedWorkMessage(action)
		};
	}
	private unsavedWorkMessage(action: AuthoringTransition) {
		const context = this.context;
		if (context?.hasPersistedChanges) {
			if (context.hasCompositionChanges)
				return 'Finish or cancel the new concession, then save or cancel your changes.';
			return action.kind === 'start'
				? 'Save or cancel your changes before starting another instruction box.'
				: 'Save or cancel your changes first.';
		}
		if (context?.hasCompositionChanges) {
			if (this.primaryAction.action === 'advance')
				return 'Finish the new concession or Cancel to discard it.';
			return this.addingConcession
				? 'Your new concession has changes. Select Add to include it, or Cancel to discard it.'
				: 'Your new concession has changes. Select Save to keep it, or Cancel to discard it.';
		}
		return 'Resolve the current operation before continuing.';
	}
	private permit(action: AuthoringTransition) {
		const decision = this.assess(action);
		if (decision.kind === 'allowed') return true;
		this.reportBlocked(decision.message);
		return false;
	}

	accept() {
		countStartupWork('authoringAccept');
		const { contract, geometry, items, itemsCurrent, lookup, detailStatus } = this.source();
		const context = this.context;
		if (!context || !contract || !geometry || !items) return;
		if (context.geometry !== geometry) context.validateGeometry = geometry.createDraftValidator();
		context.contract = contract;
		context.geometry = geometry;
		context.geometryVersion = geometry.version;
		context.itemCount = items.length;
		if (itemsCurrent) {
			const id = context.remote?._id ?? context.confirmed?._id;
			const record = id ? lookup(id)?.record : null;
			context.queryPresent = record ? true : id && detailStatus?.(id) === 'loading' ? null : false;
			if (record) {
				context.queryRevision = Math.max(context.queryRevision, record.contentRevision);
				this.observe(record);
			}
		}
		this.reconcile();
		this.reconcileSelection();
	}
	private reconcileSelection() {
		const context = this.context;
		if (!context?.confirmed || !context.selectedAnnotationId) return;
		const retained = this.source().lookup(context.confirmed._id);
		if (
			retained &&
			retained.record.contentRevision >= context.confirmed.contentRevision &&
			!retained.annotations.some((annotation) => annotation.id === context.selectedAnnotationId)
		)
			context.selectedAnnotationId = null;
	}
	private observe(record: PlaybookItemRecord) {
		const context = this.context!;
		if (!context.remote || record.contentRevision > context.remote.contentRevision)
			context.remote = immutable(record);
	}
	private reconcile() {
		const context = this.context;
		if (!context || context.operation.kind === 'missing') return;
		if (
			context.remote &&
			context.queryPresent === false &&
			context.queryRevision >= context.remote.contentRevision
		) {
			context.operation = { kind: 'missing' };
			return;
		}
		if (
			context.remote &&
			!this.dirty &&
			!this.composing &&
			(!context.confirmed || context.remote.contentRevision > context.confirmed.contentRevision)
		)
			this.adopt(context.remote);
	}
	private adopt(record: PlaybookItemRecord) {
		const context = this.context!;
		context.confirmed = immutable(record);
		context.instructions = authoringInstructions(record);
		context.trigger = record.trigger;
		context.concessions = record.concessions;
		context.workflow = { kind: 'editing' };
		context.operation = { kind: 'editing' };
		context.previewConcessionId = null;
		this.reconcileSelection();
	}
	private begin(draft: PlaybookDraft, confirmed: PlaybookItemRecord | null, workflow: Workflow) {
		this.release();
		const context = new AuthoringContext(draft, confirmed, workflow);
		this.context = context;
		context.selectedAnnotationId = draft.persistedId
			? triggerAnnotationId(confirmed?.renderKey ?? draft.persistedId)
			: null;
		this.accept();
		return context;
	}
	private release() {
		this.context = null;
		this.clearFeedback();
	}
	setInstruction(key: keyof AuthoringInstructions, text: string) {
		const context = this.context;
		if (!context || !this.canEdit) return;
		const saved = context.confirmed ? authoringInstructions(context.confirmed)[key] : undefined;
		if (text === (saved ?? '') && saved === undefined) delete context.instructions[key];
		else context.instructions[key] = text;
		this.clearFeedback();
		this.reconcile();
	}
	setConcessionDescription(text: string) {
		if (!this.canEdit || !this.context?.composer) return;
		this.context.composer.description = text;
		this.clearFeedback();
	}
	setConcessionTier(tier: Concession['tier']) {
		if (!this.canEdit || !this.context?.composer) return;
		this.context.composer.tier = tier;
		this.clearFeedback();
	}
	setReplacement(index: 0 | 1, atoms: ReplacementAtom[]) {
		const change = this.context?.composer?.changes[index];
		if (!this.canEdit || !change) return;
		change.replacement = atoms;
		this.clearFeedback();
	}
	replacementUsesParagraphs(index: 0 | 1) {
		const change = this.context?.composer?.changes[index];
		const contract = this.source().contract;
		if (!change || !contract) return true;
		return (
			change.target.kind === 'boundary' ||
			targetContainers(contract.index, change.target).every(
				(container) => contract.index.blocks.get(container.blockKey)?.kind === 'paragraph'
			)
		);
	}
	private initialSelectionEligibility(range: SourceTarget): SelectionEligibility {
		const { contract, items, available, geometry, selectionContext } = this.source();
		if (
			!available ||
			!contract ||
			!items ||
			!geometry ||
			!selectionContext ||
			selectionContext.index !== contract.index
		)
			return { allowed: false, issue: { kind: 'unavailable' } };
		return evaluateInitialSelection(contract.index, range, geometry, selectionContext);
	}
	private secondarySelectionEligibility(range: SourceTarget): SelectionEligibility {
		const { contract, items, available, geometry, selectionContext } = this.source();
		const context = this.context;
		if (
			!available ||
			!contract ||
			!items ||
			!geometry ||
			!selectionContext ||
			selectionContext.index !== contract.index ||
			!context?.composer
		)
			return { allowed: false, issue: { kind: 'unavailable' } };
		return evaluateSecondarySelection(
			contract.index,
			range,
			{
				...context.payload,
				instructions: context.payload.instructions ?? {},
				persistedId: context.confirmed?._id
			},
			geometry,
			selectionContext,
			context.composer
		);
	}
	selectionEligibility(candidate: SelectionCandidate): SelectionAvailability {
		const selectionContext = this.source().selectionContext;
		if (
			!selectionContext ||
			candidate.document !== selectionContext ||
			candidate.document.index !== this.source().contract?.index
		)
			return { allowed: false, issue: { kind: 'unavailable' } };
		const range = candidate.target;
		const purpose = this.textSelectionPurpose;
		if (!purpose)
			return {
				allowed: false,
				reason: 'Choose what you are adding before selecting another part of the contract.'
			};
		const permission =
			purpose === 'secondary-location'
				? this.secondarySelectionEligibility(range)
				: this.initialSelectionEligibility(range);
		if (!permission.allowed) return permission;
		if (purpose === 'secondary-location') {
			const decision = this.assess({ kind: 'attach-secondary' });
			return decision.kind === 'allowed'
				? permission
				: { allowed: false, reason: decision.message };
		}
		if (purpose === 'new-item') {
			const decision = this.assess({ kind: 'start' });
			return decision.kind === 'allowed'
				? permission
				: { allowed: false, reason: decision.message };
		}
		return permission;
	}
	private reportSelectionFailure(permission: SelectionAvailability) {
		if (permission.allowed) return;
		if ('reason' in permission) this.reportBlocked(permission.reason);
		else this.reportIssue(permission.issue);
	}
	private requireSelectionAction(
		candidate: SelectionCandidate,
		mode: AuthoringMode
	): SelectionEligibility | null {
		const permission = this.selectionEligibility(candidate);
		if (!permission.allowed) {
			this.reportSelectionFailure(permission);
			return null;
		}
		const action = permission.actions[mode];
		if (!action.enabled) {
			this.reportBlocked(action.reason);
			return null;
		}
		return permission;
	}
	startExplanationFromSelection(candidate: SelectionCandidate) {
		const range = candidate.target;
		if (this.textSelectionPurpose !== 'new-item') {
			this.reportBlocked(
				'Finish or cancel the current authoring task before starting an explanation.'
			);
			return false;
		}
		if (!this.requireSelectionAction(candidate, 'explain')) return false;
		this.begin(newPlaybookDraft(range), null, { kind: 'creating-explanation' });
		return true;
	}
	startConcessionFromSelection(candidate: SelectionCandidate) {
		const range = candidate.target;
		const purpose = this.textSelectionPurpose;
		if (purpose !== 'new-item') {
			this.reportBlocked('Finish or cancel the current authoring task before adding a concession.');
			return false;
		}
		if (!this.requireSelectionAction(candidate, 'concession')) return false;
		return this.beginNewConcessionAt(range);
	}
	attachSecondaryLocation(candidate: SelectionCandidate) {
		const range = candidate.target;
		if (this.textSelectionPurpose !== 'secondary-location' || !this.context?.composer) {
			this.reportBlocked('Choose the other-part step before selecting another passage.');
			return false;
		}
		if (!this.requireSelectionAction(candidate, 'concession')) return false;
		this.context.composer.changes = [
			this.context.composer.changes[0],
			{ target: range, replacement: [{ kind: 'text', text: '' }] }
		];
		this.clearFeedback();
		return true;
	}
	private beginNewConcessionAt(range: SourceTarget) {
		const concession: Concession = {
			id: newConcessionId(),
			tier: 'preferred',
			description: '',
			changes: [{ target: range, replacement: [{ kind: 'text', text: '' }] }]
		};
		this.begin(newPlaybookDraft(range), null, {
			kind: 'creating-concession',
			step: 'concession',
			affectsOtherParts: false,
			baseline: immutable(semanticConcession(concession)),
			concession
		});
		return true;
	}
	requestItemSwitch(itemId: string, annotationId: string) {
		const retained = this.source().lookup(itemId);
		const item = retained?.record;
		const annotation = retained?.annotations.find((annotation) => annotation.id === annotationId);
		if (!item || !annotation || !this.permit({ kind: 'switch-item', itemId })) return false;
		if (this.draft?.persistedId !== itemId)
			this.begin({ ...item, instructions: item.instructions ?? {}, persistedId: item._id }, item, {
				kind: 'editing'
			});
		else this.clearFeedback();
		const context = this.context!;
		context.selectedAnnotationId = annotationId;
		return true;
	}
	addConcession(tier: Concession['tier']) {
		if (!this.permit({ kind: 'start-addition' })) return false;
		const { contract, items, available, geometry, selectionContext } = this.source();
		if (
			!available ||
			!contract ||
			!items ||
			!geometry ||
			!selectionContext ||
			selectionContext.index !== contract.index
		) {
			this.reportBlocked('Wait for the current contract');
			return false;
		}
		const context = this.context!;
		const draft = {
			...context.payload,
			instructions: context.payload.instructions ?? {},
			persistedId: context.confirmed?._id
		};
		const trigger = draft.trigger;
		const range: SourceTarget =
			trigger.target.kind === 'boundary'
				? { kind: 'boundary', afterBlockKey: trigger.target.afterBlockKey }
				: {
						kind: 'text',
						range: {
							start: { ...trigger.target.range.start },
							end: { ...trigger.target.range.end }
						}
					};
		const permission = evaluateConcessionAddition(
			contract.index,
			range,
			draft,
			geometry,
			selectionContext
		);
		if (!permission.allowed) {
			this.reportBlocked(selectionIssueMessage(permission.issue));
			return false;
		}
		const concessionAction = permission.actions.concession;
		if (!concessionAction.enabled) {
			this.reportBlocked(concessionAction.reason);
			return false;
		}
		const concession: Concession = {
			id: newConcessionId(),
			tier,
			description: '',
			changes: [{ target: range, replacement: [{ kind: 'text', text: '' }] }]
		};
		context.workflow = {
			kind: 'adding-concession',
			step: 'concession',
			affectsOtherParts: false,
			triggerId: trigger.id,
			concession,
			baseline: immutable(semanticConcession(concession))
		};
		context.previewConcessionId = null;
		this.clearFeedback();
		return true;
	}
	removeConcession(id: string) {
		const context = this.context;
		if (this.creating || !context?.confirmed || !this.canEdit) {
			this.reportBlocked(
				'Finish or cancel the current operation or creation before updating this instruction box'
			);
			return false;
		}
		if (!context.concessions.some((concession) => concession.id === id)) {
			this.reportBlocked('This concession is no longer available');
			return false;
		}
		context.concessions = immutable(
			context.concessions.filter((concession) => concession.id !== id)
		);
		if (context.previewConcessionId === id) context.previewConcessionId = null;
		this.clearFeedback();
		this.reconcile();
		return true;
	}
	private cancelAddition() {
		if (!this.context || !this.addingConcession) return;
		this.context.workflow = { kind: 'editing' };
		this.clearFeedback();
		this.reconcile();
	}
	setAffectedPart(value: boolean) {
		const workflow = this.workflow;
		if (!this.canEdit || !workflow || !('step' in workflow)) return;
		workflow.affectsOtherParts = value;
		if (!value) workflow.concession.changes = workflow.concession.changes.slice(0, 1);
		this.clearFeedback();
	}
	cancelSecondaryLocationChoice() {
		const workflow = this.workflow;
		if (!this.canCancelLocation || !workflow || !('step' in workflow)) return;
		workflow.step = 'concession';
		workflow.concession.changes = workflow.concession.changes.slice(0, 1);
		this.clearFeedback();
	}
	primary(): AuthoringOutcome {
		const context = this.context;
		const { action, disabled } = this.primaryAction;
		if (disabled || !context) return 'retained';
		if (action === 'advance' && 'step' in context.workflow) {
			context.workflow.step = 'other-part';
			this.clearFeedback();
			return 'retained';
		}
		if (action === 'add' && context.workflow.kind === 'adding-concession') {
			const concession = immutable(semanticConcession(context.workflow.concession));
			context.concessions = immutable([...context.concessions, concession]);
			this.cancelAddition();
			context.previewConcessionId = concession.id;
			return 'retained';
		}
		return this.execute(
			immutable({
				kind: 'save',
				request: {
					...(context.confirmed ? { id: context.confirmed._id } : {}),
					item: context.payload,
					expectedContentRevision: context.confirmed?.contentRevision ?? 0,
					operationId: crypto.randomUUID()
				}
			})
		);
	}
	remove(): AuthoringOutcome {
		const record = this.context?.confirmed;
		return this.canDelete && record
			? this.execute(
					immutable({
						kind: 'delete',
						id: record._id,
						expectedContentRevision: record.contentRevision
					})
				)
			: 'retained';
	}
	private execute(operation: Operation): AuthoringOutcome {
		const context = this.context;
		if (!context || !this.submission.available) return 'retained';
		this.clearFeedback();
		const recovery = immutable({ item: context.payload });
		if (!this.submission.submit(operation, recovery)) return 'retained';
		this.release();
		return 'closed';
	}
	/** Recovery is a new editing attempt; submitting it captures a fresh operation/revision. */
	restore(recovery: AuthoringRecovery, current: PlaybookItemRecord | null) {
		const context = this.begin(
			{
				...recovery.item,
				instructions: recovery.item.instructions ?? {},
				...(current ? { persistedId: current._id } : {})
			},
			current,
			{ kind: current ? 'editing' : 'creating-explanation' }
		);
		context.instructions = authoringInstructions(recovery.item);
		context.trigger = immutable(recovery.item.trigger);
		context.concessions = immutable(recovery.item.concessions);
	}
	cancel(): AuthoringOutcome {
		if (!this.permit({ kind: 'cancel' })) return 'retained';
		if (!this.context) return 'retained';
		if (this.addingConcession) {
			this.cancelAddition();
			return 'retained';
		}
		this.release();
		return 'closed';
	}
	/** A completed click-away closes a clean editor, but cancels work that would be discarded. */
	dismissFromOutside(): AuthoringOutcome {
		if (!this.context) return 'retained';
		if (this.dirty) return this.cancel();
		this.release();
		return 'closed';
	}
	leave(discardConfirmed = false) {
		const decision = this.assess({ kind: 'leave' });
		if (decision.kind === 'blocked' || (decision.kind === 'confirm-discard' && !discardConfirmed)) {
			this.reportBlocked(decision.message);
			return false;
		}
		this.release();
		return true;
	}
	useSaved() {
		if (this.phase?.kind !== 'conflict' || !this.context?.remote) return;
		this.adopt(this.context.remote);
		this.clearFeedback();
		this.reconcile();
	}
	discard() {
		this.release();
		this.referenceCatalogCache = undefined;
	}
}
