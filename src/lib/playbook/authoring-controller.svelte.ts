import type { BreakPolicyContext, SelectionCandidate } from '../document/selection/selection-model';
import type { CompiledDocument } from '../document/compiled-document';
import type { Address } from '../document/numbering';
import { targetContainers } from '../document/ranges';
import { createReferenceCatalog, type ReferenceCatalog } from '../document/reference-catalog';
import { hasMeaningfulReplacement } from '../document/replacement-content';
import type { ReplacementAtom } from '../document/source-model';
import { countStartupWork } from '../document/runtime/render-perf';
import { immutable, type DeepReadonly } from '../immutable';
import { AuthoringContext } from './authoring-context.svelte';
import { semanticConcession, semanticTarget } from './content';
import { triggerAnnotationId } from './document-overlay';
import { newTemplateDraft, templateDraft, type TemplateDraft } from './draft';
import type { PlaybookGeometryIndex } from './geometry-index';
import {
	newConcessionId,
	type Instructions,
	type Concession,
	isRepItem,
	type TemplateAudience,
	type TemplateItem,
	type SourceTarget
} from './model';
import type { TemplateItemRecord } from './structure';
import { templateCopy } from './template-copy';
import type { Operation } from './save-transport';
import {
	evaluateConcessionAddition,
	evaluateInitialSelection,
	evaluateSecondarySelection,
	selectionIssueMessage,
	type SelectionAvailability,
	type SelectionEligibility,
	type SelectionIssue
} from './source-picking';

export type AuthoringSource = {
	selectionContext?: BreakPolicyContext;
	document: CompiledDocument | null;
	geometry: PlaybookGeometryIndex | null;
	items: readonly { _id: string }[] | null;
	available: boolean;
	editingAvailable?: boolean;
	editingUnavailableReason?: string;
	itemsCurrent: boolean;
	addresses?: ReadonlyMap<string, Address>;
	lookup: (id: string) => {
		record: DeepReadonly<TemplateItemRecord>;
		annotations: readonly import('./document-overlay').DocumentAnnotation[];
	} | null;
	detailStatus?: (id: string) => 'present' | 'missing' | 'loading';
};
export type AuthoringRecovery = {
	item: DeepReadonly<TemplateItem>;
};
export type AuthoringTransition =
	| { kind: 'switch-item'; itemId: string }
	| { kind: 'start' }
	| { kind: 'attach-secondary' }
	| { kind: 'start-addition' }
	| { kind: 'leave' };
export type TransitionDecision =
	| { kind: 'allowed' }
	| { kind: 'blocked'; message: string }
	| { kind: 'confirm-discard'; message: string };
export type AuthoringOutcome = 'retained' | 'closed';
export type TextSelectionPurpose = 'new-item' | 'secondary-location';
const SECONDARY_BLOCKED =
	'Tick "This concession affects another part of the template" before selecting another passage.';

/** Route-attached draft commands and source validation. The workspace owns submitted work. */
export class AuthoringController {
	private context = $state.raw<AuthoringContext | null>(null);
	private releaseContext?: () => void;
	private issue = $state<SelectionIssue | null>(null);
	private warning = $state('');
	private referenceCatalogCache:
		| {
				index: CompiledDocument['index'] | undefined;
				addresses: ReadonlyMap<string, Address> | undefined;
				catalog: ReferenceCatalog;
		  }
		| undefined;
	constructor(
		private source: () => AuthoringSource,
		private submission: {
			readonly available: boolean;
			readonly reason: string;
			submit(operation: DeepReadonly<Operation>, recovery: AuthoringRecovery): boolean;
		},
		readonly audience: TemplateAudience
	) {}
	get copy() {
		return templateCopy(this.audience);
	}
	get entry(): object | null {
		return this.context;
	}
	get draft() {
		return this.context?.draft ?? null;
	}
	get concessionComposer(): DeepReadonly<Concession> | undefined {
		return this.context?.concessionDraft?.concession;
	}
	get addingConcession() {
		return Boolean(this.context?.concessionDraft);
	}
	get affectsOtherParts() {
		return this.context?.concessionDraft?.affectsOtherParts ?? false;
	}
	get selectedAnnotationId() {
		return this.context?.selectedAnnotationId ?? null;
	}
	get previewConcessionId() {
		return this.context?.previewConcessionId ?? null;
	}
	private get dirty() {
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
			(this.dirty || this.addingConcession)
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
		if (!source.itemsCurrent) return this.copy.refreshing;
		const id = this.context?.confirmed?._id;
		if (id && source.detailStatus) {
			const status = source.detailStatus(id);
			if (status === 'loading') return this.copy.loadingSelected;
			if (status === 'missing') return this.copy.missingSelected;
		}
		return this.copy.unavailable;
	}
	get canDelete() {
		return (
			!this.addingConcession &&
			Boolean(this.context?.confirmed) &&
			this.canEdit &&
			this.submission.available
		);
	}
	get statusMessage() {
		const phase = this.phase;
		switch (phase?.kind) {
			case 'conflict':
				return this.copy.conflict;
			case 'missing':
				return this.copy.deleted;
			default:
				return '';
		}
	}
	private get secondarySelection() {
		return this.concessionComposer?.changes[1]?.target;
	}
	/** Once the other passage is picked, the editor rests beside it instead of returning to the clause. */
	get panelTarget() {
		return this.secondarySelection ?? this.draft?.trigger.target;
	}
	/** The only mode in which the editor follows scroll and the document picks a second passage. */
	get pickingSecondaryLocation() {
		return (
			this.addingConcession && this.canEdit && this.affectsOtherParts && !this.secondarySelection
		);
	}
	private get textSelectionPurpose(): TextSelectionPurpose | null {
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
		const index = source.document?.index;
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
	private selectionSource() {
		const { document, items, available, geometry, selectionContext } = this.source();
		if (
			!available ||
			!document ||
			!items ||
			!geometry ||
			!selectionContext ||
			selectionContext.index !== document.index
		)
			return null;
		return { document, geometry, selectionContext };
	}
	private currentConcessionAdditionReason = $derived.by(() => {
		const context = this.context;
		if (this.audience !== 'rep' || !context || this.addingConcession) return '';
		const ready = this.selectionSource();
		if (!ready) return this.canEdit ? 'Wait for the current template' : '';
		void context.geometryVersion;
		const permission = evaluateConcessionAddition(
			ready.document.index,
			context.trigger,
			context.confirmed?._id,
			ready.geometry,
			ready.selectionContext
		);
		return permission.allowed ? '' : selectionIssueMessage(permission.issue, this.audience);
	});
	get concessionAdditionReason() {
		return this.currentConcessionAdditionReason;
	}
	get feedback() {
		return this.warning || (this.issue ? selectionIssueMessage(this.issue, this.audience) : '');
	}
	private get primaryIncompleteReason() {
		const concession = this.concessionComposer;
		if (!concession) return '';
		if (!hasMeaningfulReplacement(concession.changes[0].replacement))
			return 'Add replacement text before continuing.';
		if (!concession.description.trim()) return 'Describe the concession before continuing.';
		return '';
	}
	/** Ticking requires both primary fields; unticking is always allowed. */
	get affectedPartAvailable() {
		return this.canEdit && (this.affectsOtherParts || !this.primaryIncompleteReason);
	}
	private get concessionIncompleteReason() {
		const concession = this.concessionComposer;
		if (!concession) return '';
		if (this.primaryIncompleteReason) return this.primaryIncompleteReason;
		if (this.affectsOtherParts && !this.secondarySelection)
			return 'Select the other part of the template before adding.';
		return '';
	}
	private currentPrimaryAction = $derived.by(() => {
		const context = this.context;
		const action = this.addingConcession ? 'add' : 'save';
		const reason = !context
			? ''
			: !this.canEdit
				? this.editingUnavailableReason
				: this.addingConcession
					? this.concessionIncompleteReason || context.concessionValidation
					: context.validation || (!this.submission.available ? this.submission.reason : '');
		const label = action === 'add' ? 'Add' : 'Save';
		return {
			action,
			label,
			reason,
			disabled:
				!this.canEdit ||
				(action === 'save' && (!this.submission.available || !this.dirty)) ||
				Boolean(reason)
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
		if (action.kind === 'attach-secondary')
			return this.pickingSecondaryLocation
				? { kind: 'allowed' }
				: {
						kind: 'blocked',
						message: SECONDARY_BLOCKED
					};
		if (action.kind === 'start-addition')
			return !this.addingConcession && this.context && this.canEdit
				? { kind: 'allowed' }
				: {
						kind: 'blocked',
						message: 'Finish or cancel the current edit before adding a concession.'
					};
		if (action.kind === 'leave')
			return this.hasUnsavedWork
				? {
						kind: 'confirm-discard',
						message: this.copy.leaveConfirm
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
				? this.copy.startUnsaved
				: 'Save or cancel your changes first.';
		}
		return 'Your new concession has changes. Select Add to include it, or Cancel to discard it.';
	}
	private permit(action: AuthoringTransition) {
		const decision = this.assess(action);
		if (decision.kind === 'allowed') return true;
		this.reportBlocked(decision.message);
		return false;
	}

	accept() {
		countStartupWork('authoringAccept');
		const { document, geometry, items, itemsCurrent, lookup, detailStatus } = this.source();
		const context = this.context;
		if (!context || !document || !geometry || !items) return;
		context.document = document;
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
	private observe(record: DeepReadonly<TemplateItemRecord>) {
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
			!this.addingConcession &&
			(!context.confirmed || context.remote.contentRevision > context.confirmed.contentRevision)
		)
			this.adopt(context.remote);
	}
	private adopt(record: DeepReadonly<TemplateItemRecord>) {
		const context = this.context!;
		context.confirmed = immutable(record);
		context.adoptContent(record);
		context.trigger = record.trigger;
		context.concessions = isRepItem(record) ? record.concessions : [];
		context.concessionDraft = null;
		context.operation = { kind: 'editing' };
		context.previewConcessionId = null;
		this.reconcileSelection();
	}
	private begin(
		draft: DeepReadonly<TemplateDraft>,
		confirmed: DeepReadonly<TemplateItemRecord> | null
	) {
		this.release();
		// Callers may run inside short-lived effects; the context's deriveds must live as long as the draft.
		let context!: AuthoringContext;
		this.releaseContext = $effect.root(() => {
			context = new AuthoringContext(draft, confirmed, this.audience);
		});
		this.context = context;
		context.selectedAnnotationId = draft.persistedId
			? triggerAnnotationId(confirmed?.renderKey ?? draft.persistedId)
			: null;
		this.accept();
		return context;
	}
	private release() {
		this.context = null;
		this.releaseContext?.();
		this.releaseContext = undefined;
		this.clearFeedback();
	}
	setInstruction(key: keyof Instructions, text: string) {
		const context = this.context;
		if (!context || context.content.audience !== 'rep' || !this.canEdit) return;
		if (text === '') delete context.content.instructions[key];
		else context.content.instructions[key] = text;
		this.clearFeedback();
		this.reconcile();
	}
	setApprovalGuidance(text: string) {
		const context = this.context;
		if (!context || context.content.audience !== 'rep' || !this.canEdit) return;
		context.content.approvalPolicy =
			text === '' ? { kind: 'none' } : { kind: 'required', instructions: text };
		this.clearFeedback();
		this.reconcile();
	}
	setExplanation(text: string) {
		const context = this.context;
		if (!context || context.content.audience !== 'buyer' || !this.canEdit) return;
		context.content.explanation = text;
		this.clearFeedback();
		this.reconcile();
	}
	setConcessionDescription(text: string) {
		const draft = this.context?.concessionDraft;
		if (!this.canEdit || !draft) return;
		draft.concession.description = text;
		this.clearFeedback();
	}
	setReplacement(index: 0 | 1, atoms: ReplacementAtom[]) {
		const change = this.context?.concessionDraft?.concession.changes[index];
		if (!this.canEdit || !change) return;
		change.replacement = atoms;
		this.clearFeedback();
	}
	replacementUsesParagraphs(index: 0 | 1) {
		const change = this.context?.concessionDraft?.concession.changes[index];
		const document = this.source().document;
		if (!change || !document) return true;
		return (
			change.target.kind === 'boundary' ||
			targetContainers(document.index, change.target).every(
				(container) => document.index.blocks.get(container.blockKey)?.kind === 'paragraph'
			)
		);
	}
	private initialSelectionEligibility(range: SourceTarget): SelectionEligibility {
		const ready = this.selectionSource();
		if (!ready) return { allowed: false, issue: { kind: 'unavailable' } };
		return evaluateInitialSelection(
			ready.document.index,
			range,
			ready.geometry,
			ready.selectionContext,
			this.audience
		);
	}
	private secondarySelectionEligibility(range: SourceTarget): SelectionEligibility {
		const ready = this.selectionSource();
		const context = this.context;
		if (!ready || !context?.concessionDraft || context.content.audience !== 'rep')
			return { allowed: false, issue: { kind: 'unavailable' } };
		return evaluateSecondarySelection(
			ready.document.index,
			range,
			context.trigger,
			context.confirmed?._id,
			ready.geometry,
			ready.selectionContext,
			context.concessionDraft.concession
		);
	}
	selectionEligibility(candidate: SelectionCandidate): SelectionAvailability {
		const selectionContext = this.source().selectionContext;
		if (
			!selectionContext ||
			candidate.document !== selectionContext ||
			candidate.document.index !== this.source().document?.index
		)
			return { allowed: false, issue: { kind: 'unavailable' } };
		const range = candidate.target;
		const purpose = this.textSelectionPurpose;
		if (!purpose)
			return {
				allowed: false,
				reason: 'Choose what you are adding before selecting another part of the template.'
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
	private requireSelection(candidate: SelectionCandidate): boolean {
		const permission = this.selectionEligibility(candidate);
		if (!permission.allowed) {
			this.reportSelectionFailure(permission);
			return false;
		}
		return true;
	}
	confirmSelection(candidate: SelectionCandidate) {
		return this.textSelectionPurpose === 'secondary-location'
			? this.attachSecondaryLocation(candidate)
			: this.startItemFromSelection(candidate);
	}
	private startItemFromSelection(candidate: SelectionCandidate) {
		const range = candidate.target;
		if (this.textSelectionPurpose !== 'new-item') {
			this.reportBlocked(this.copy.startBlocked);
			return false;
		}
		if (!this.requireSelection(candidate)) return false;
		if (this.audience === 'buyer') {
			if (range.kind !== 'text') return false;
			this.begin(newTemplateDraft(range, 'buyer'), null);
		} else {
			this.begin(newTemplateDraft(range, 'rep'), null);
		}
		return true;
	}
	private attachSecondaryLocation(candidate: SelectionCandidate) {
		const range = candidate.target;
		const draft = this.context?.concessionDraft;
		if (this.textSelectionPurpose !== 'secondary-location' || !draft) {
			this.reportBlocked(SECONDARY_BLOCKED);
			return false;
		}
		if (!this.requireSelection(candidate)) return false;
		draft.concession.changes = [
			draft.concession.changes[0],
			{ target: range, replacement: [{ kind: 'text', text: '' }] }
		];
		this.clearFeedback();
		return true;
	}
	requestItemSwitch(itemId: string, annotationId: string) {
		const retained = this.source().lookup(itemId);
		const item = retained?.record;
		const annotation = retained?.annotations.find((annotation) => annotation.id === annotationId);
		if (!item || !annotation || !this.permit({ kind: 'switch-item', itemId })) return false;
		if (this.draft?.persistedId !== itemId) this.begin(templateDraft(item, item._id), item);
		else this.clearFeedback();
		const context = this.context!;
		context.selectedAnnotationId = annotationId;
		return true;
	}
	addConcession(tier: Concession['tier']) {
		if (this.audience !== 'rep') return false;
		if (!this.permit({ kind: 'start-addition' })) return false;
		const context = this.context!;
		if (context.content.audience !== 'rep') return false;
		const reason = this.concessionAdditionReason;
		if (reason) {
			this.reportBlocked(reason);
			return false;
		}
		const range = semanticTarget(context.trigger.target);
		const concession: Concession = {
			id: newConcessionId(),
			tier,
			description: '',
			changes: [{ target: range, replacement: [{ kind: 'text', text: '' }] }]
		};
		context.concessionDraft = {
			affectsOtherParts: false,
			concession,
			originalConcession: immutable(semanticConcession(concession))
		};
		context.previewConcessionId = null;
		this.clearFeedback();
		return true;
	}
	removeConcession(id: string) {
		const context = this.context;
		if (this.addingConcession || !context || context.content.audience !== 'rep' || !this.canEdit) {
			this.reportBlocked('Finish or cancel the current edit before updating these instructions');
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
		this.context.concessionDraft = null;
		this.clearFeedback();
		this.reconcile();
	}
	setAffectedPart(value: boolean) {
		const draft = this.context?.concessionDraft;
		if (!draft || value === draft.affectsOtherParts || !this.affectedPartAvailable) return;
		draft.affectsOtherParts = value;
		if (!value) draft.concession.changes = draft.concession.changes.slice(0, 1);
		this.clearFeedback();
	}
	primary(): AuthoringOutcome {
		const context = this.context;
		const { action, disabled } = this.primaryAction;
		if (disabled || !context) return 'retained';
		if (action === 'add' && context.concessionDraft) {
			const concession = immutable(semanticConcession(context.concessionDraft.concession));
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
	private execute(operation: DeepReadonly<Operation>): AuthoringOutcome {
		const context = this.context;
		if (!context || !this.submission.available) return 'retained';
		this.clearFeedback();
		const recovery = immutable({ item: context.payload });
		if (!this.submission.submit(operation, recovery)) return 'retained';
		this.release();
		return 'closed';
	}
	/** Recovery is a new editing attempt; submitting it captures a fresh operation/revision. */
	restore(recovery: AuthoringRecovery, current: DeepReadonly<TemplateItemRecord> | null) {
		const context = this.begin(templateDraft(recovery.item, current?._id), current);
		context.adoptContent(recovery.item);
		context.trigger = immutable(recovery.item.trigger);
		context.concessions = immutable(isRepItem(recovery.item) ? recovery.item.concessions : []);
	}
	cancel(): AuthoringOutcome {
		if (!this.context) return 'retained';
		if (this.addingConcession) {
			this.cancelAddition();
			return 'retained';
		}
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
