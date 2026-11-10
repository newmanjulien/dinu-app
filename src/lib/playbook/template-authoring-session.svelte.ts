import { authoringRecord } from './authoring-item';
import type { InstructionAudience } from './model';
import type { SnapshotClient } from '../query-once';
import { getContext, setContext } from 'svelte';
import type { ConvexClient } from 'convex/browser';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { SessionEditor } from '../auth/viewer-session.svelte';
import { immutable, type DeepReadonly } from '../immutable';
import type {
	AuthoringController,
	AuthoringRecovery,
	AuthoringSource
} from './authoring-controller.svelte';
import {
	convexSaveTransport,
	type Operation,
	type SaveResult,
	type SaveTransport
} from './save-transport';
import {
	itemStructure,
	playbookStructure,
	type AuthoringWatermark,
	type ContentSnapshot,
	type AuthoringSourceIdentity,
	type StructureSnapshot
} from './structure';
import type { PlaybookItemRecord, SourceTarget } from './model';
import { equalItemStructure } from './structure-codec';
import type { AnnotationAdmission, AuthoringSelectionRequest } from './authoring-selection';

type Confirmation = Extract<SaveResult, { status: 'saved' | 'deleted' }>;
type Submission = {
	operation: DeepReadonly<Operation>;
	recovery: DeepReadonly<AuthoringRecovery>;
	templateSourceFingerprint: string;
	templateSourceId: Id<'templateSources'> | null;
	authoringGeneration: number;
	phase: 'saving' | 'uncertain' | 'recovery' | 'confirmed';
	message: string;
	confirmation?: DeepReadonly<Confirmation>;
	learnedTargetId?: string;
	recoveryWitness?: {
		watermark: AuthoringWatermark & AuthoringSourceIdentity;
	} & ({ kind: 'conflict'; itemId: string; minimumContentRevision: number } | { kind: 'missing' });
	structureAccepted: boolean;
	detailAccepted: boolean;
};
const unavailable: AuthoringSource = {
	document: null,
	geometry: null,
	items: null,
	available: false,
	itemsCurrent: false,
	lookup: () => null
};
const watermarkAtLeast = (value: AuthoringWatermark, other: AuthoringWatermark) =>
	value.templateSourceFingerprint === other.templateSourceFingerprint &&
	value.authoringGeneration >= other.authoringGeneration;
const sameSource = (a: AuthoringSourceIdentity, b: AuthoringSourceIdentity) =>
	a.templateSourceId === b.templateSourceId &&
	a.templateSourceFingerprint === b.templateSourceFingerprint;
const PRELOAD_ITEMS = 64;
const PRELOAD_BYTES = 4 * 1024 * 1024;
const PRELOAD_CONCURRENCY = 8;
const RECENT_ITEMS = 8;
type DetailSubscription = {
	release?: () => void;
	snapshot?: ContentSnapshot;
	error?: string;
	awaiting: boolean;
	bytes: number;
};

/** Membership lifetime. No DOM, renderer, route callbacks or template source prose is retained here. */
export class TemplateAuthoringSession {
	structure = $state.raw<StructureSnapshot | null>(null);
	structureError = $state('');
	private structureLoading = $state(false);
	private details = new Map<string, DetailSubscription>();
	private detailVersion = $state(0);
	private projectedDetails: DeepReadonly<PlaybookItemRecord[]> = [];
	private preloadTemplateSource: string | null = null;
	private recentIds: string[] = [];
	private nearbyIds: readonly string[] = [];
	private memberIds: string[] = [];
	private ranking: string[] = [];
	private rankingDirty = true;
	private failedPreloads = new Set<string>();
	private byteCutoff = Infinity;
	private nearbyReporter = $state.raw<((ids: readonly string[]) => void) | undefined>();
	private syncing = false;
	private resync = false;
	private slot = $state.raw<Submission | null>(null);
	private attached = $state(false);
	private frozen = $state(false);
	private available = $state(true);
	private suspended = false;
	private disposed = false;
	private source: (() => AuthoringSource) | null = null;
	private editor = $state.raw<AuthoringController | null>(null);
	private selectedId = $state<string | null>(null);
	private requestedSelection = $state.raw<
		| (AuthoringSelectionRequest & {
				entry: object | null;
				target: SourceTarget;
		  })
		| null
	>(null);
	private structureRelease?: () => void;
	private transport: SaveTransport;
	private attempt: object | null = null;
	private running: Promise<void> | null = null;
	private generation = 0;
	private transportGeneration = 0;
	private unregister?: () => void;
	private leaveWaiters = new Set<() => void>();
	completion = $state.raw<{ kind: 'saved' | 'deleted' } | null>(null);
	constructor(
		private options: {
			client: SnapshotClient & Pick<ConvexClient, 'mutation'>;
			membershipId: Id<'memberships'>;
			companyId: Id<'company'>;
			audience?: InstructionAudience;
			registerEditor: (editor: SessionEditor) => () => void;
		}
	) {
		this.transport = convexSaveTransport(options.client, options.membershipId, options.audience);
	}
	start() {
		const owner = this;
		this.unregister = this.options.registerEditor({
			get pending() {
				return owner.pending;
			},
			prepareToLeave: () => this.prepareToLeave(),
			retry: () => {
				void this.retry();
			},
			suspend: () => {
				this.suspended = true;
				this.syncSubscriptions();
			},
			resume: () => {
				this.suspended = false;
				this.syncSubscriptions();
			},
			freeze: (frozen) => {
				this.frozen = frozen;
				this.syncSubscriptions();
			},
			discard: () => this.discard(),
			restartTransport: () => this.restartTransport()
		});
	}
	configure(available: boolean, frozen: boolean, transportGeneration: number) {
		this.available = available;
		this.frozen = frozen;
		if (transportGeneration !== this.transportGeneration) {
			this.transportGeneration = transportGeneration;
			this.restartTransport();
		}
		this.syncSubscriptions();
	}
	private Controller?: typeof AuthoringController;
	installController(Controller: typeof AuthoringController) {
		this.Controller = Controller;
	}
	get controller() {
		if (!this.editor) {
			const owner = this;
			if (!this.Controller)
				throw new Error('Open the template editor before creating an instruction draft.');
			this.editor = new this.Controller(
				() => this.source?.() ?? unavailable,
				{
					get available() {
						return owner.canSubmit;
					},
					get reason() {
						if (!owner.available) return 'Instruction editing is temporarily unavailable.';
						if (owner.frozen || owner.suspended) return 'Waiting for your account to be ready…';
						if (owner.slot?.phase === 'recovery')
							return 'Restore or discard the retained draft before saving another draft.';
						if (owner.slot)
							return 'Wait for the submitted save to finish before saving another draft.';
						return owner.structureError || 'Refreshing instructions…';
					},
					submit: (operation, recovery) => this.submit(operation, recovery)
				},
				this.options.audience
			);
		}
		return this.editor;
	}
	attach(source: () => AuthoringSource) {
		if (this.source !== source) this.resetPreloading();
		this.source = source;
		this.attached = true;
		this.syncSubscriptions();
		return () => {
			if (this.source !== source) return;
			this.resetPreloading();
			this.source = null;
			this.attached = false;
			this.requestedSelection = null;
			this.selectedId = null;
			this.preloadTemplateSource = null;
			this.editor?.discard();
			this.syncSubscriptions();
		};
	}
	get pending() {
		return Boolean(this.slot || (this.attached && this.editor?.hasUnsavedWork));
	}
	get hydratedDetails(): DeepReadonly<PlaybookItemRecord[]> {
		const records: DeepReadonly<PlaybookItemRecord>[] = [];
		if (this.selectedId) {
			const detail = this.detail(this.selectedId);
			if (detail) records.push(detail);
		}
		const result = this.slot?.confirmation;
		if (result?.status === 'saved' && !records.some((record) => record._id === result.item._id)) {
			const detail = this.detail(result.item._id);
			if (detail) records.push(detail);
		}
		if (
			records.length !== this.projectedDetails.length ||
			records.some((record, index) => record !== this.projectedDetails[index])
		)
			this.projectedDetails = records;
		return this.projectedDetails;
	}
	get canSubmit() {
		return this.available && !this.frozen && !this.suspended && !this.slot && this.current;
	}
	get current() {
		return Boolean(
			this.structure?.ready &&
			!this.structureLoading &&
			!this.structureError &&
			this.available &&
			!this.suspended
		);
	}
	get detailError() {
		void this.detailVersion;
		for (const id of this.pinnedIds()) {
			const error = this.details.get(id)?.error;
			if (error) return error;
		}
		return '';
	}
	get phase() {
		return this.slot?.phase;
	}
	get message() {
		return this.slot?.message || this.structureError || this.detailError;
	}
	get status() {
		switch (this.slot?.phase) {
			case 'saving':
				return 'Saving instructions…';
			case 'confirmed':
				return this.structureError || this.detailError
					? 'Instructions saved; refresh needed'
					: 'Instructions saved';
			case 'uncertain':
				return 'Instruction save needs confirmation';
			case 'recovery':
				return 'Instruction draft needs attention';
			default:
				return null;
		}
	}
	get needsAttention() {
		return (
			this.slot?.phase === 'uncertain' ||
			this.slot?.phase === 'recovery' ||
			(this.slot?.phase === 'confirmed' && Boolean(this.structureError || this.detailError))
		);
	}
	get pendingPanel() {
		const request = this.requestedSelection;
		if (request?.status !== 'pending') return null;
		void this.detailVersion;
		return {
			...request,
			error: this.details.get(request.itemId)?.error ?? ''
		};
	}
	get selectionRequest(): AuthoringSelectionRequest | null {
		const request = this.requestedSelection;
		if (!request) return null;
		const { token, itemId, annotationId, status } = request;
		return { token, itemId, annotationId, status };
	}
	get pendingRenderKey() {
		const slot = this.slot;
		const operation = slot?.operation;
		return slot &&
			slot.phase !== 'recovery' &&
			slot.phase !== 'confirmed' &&
			operation?.kind === 'save'
			? operation.request.id
				? this.structure?.items.find((item) => item._id === operation.request.id)?.renderKey
				: operation.request.operationId
			: undefined;
	}
	get projectedStructure(): StructureSnapshot | null {
		const base = this.structure,
			slot = this.slot;
		if (!base || !slot || slot.phase === 'recovery' || !sameSource(slot, base)) return base;
		const response = slot.confirmation;
		if (response && slot.structureAccepted) return base;
		const operation = slot.operation;
		const id =
			response?.status === 'saved'
				? response.item._id
				: operation.kind === 'save'
					? (operation.request.id ??
						base.items.find((item) => item.renderKey === operation.request.operationId)?._id)
					: operation.id;
		if (operation.kind === 'delete')
			return { ...base, items: base.items.filter((item) => item._id !== id) };
		const old = base.items.find((item) => item._id === id);
		const record =
			response?.status === 'saved'
				? response.item
				: {
						...operation.request.item,
						_id: (id ?? `pending:${operation.request.operationId}`) as Id<'playbookItems'>,
						_creationTime: old?._creationTime ?? 0,
						companyId: this.options.companyId,
						contentRevision: operation.request.expectedContentRevision + 1,
						renderKey: old?.renderKey ?? operation.request.operationId
					};
		const projected = {
			...itemStructure(record, record.renderKey ?? old?.renderKey),
			companyId: this.options.companyId
		};
		return {
			...base,
			items: old
				? base.items.map((item) => (item._id === id ? projected : item))
				: [...base.items, projected]
		};
	}
	/** Read eligibility is independent of renderer/selection readiness. */
	configurePreloading(templateSourceFingerprint: string | null) {
		if (this.preloadTemplateSource === templateSourceFingerprint) return;
		this.preloadTemplateSource = templateSourceFingerprint;
		this.resetPreloading();
		this.syncSubscriptions();
	}
	get instructionPreload() {
		return this.nearbyReporter;
	}
	private get canPreload() {
		return Boolean(
			!this.disposed &&
			this.attached &&
			this.source &&
			this.available &&
			!this.suspended &&
			!this.frozen &&
			this.current &&
			this.preloadTemplateSource &&
			this.preloadTemplateSource === this.structure?.templateSourceFingerprint
		);
	}
	private observedDetail(id: string) {
		void this.detailVersion;
		const entry = this.details.get(id);
		return entry?.error ? undefined : entry?.snapshot;
	}
	private authoritativeDetail(id: string, value: ContentSnapshot | undefined) {
		const base = this.structure;
		if (!this.current || !base?.ready || !value?.ready || !sameSource(value, base)) return;
		const head = base.items.find((item) => item._id === id);
		if (
			value.status === 'present' &&
			head &&
			head._id === value.item._id &&
			head.companyId === value.item.companyId &&
			head._creationTime === value.item._creationTime &&
			head.contentRevision === value.item.contentRevision &&
			head.renderKey === value.item.renderKey
		)
			return value;
	}
	detail(id: string): DeepReadonly<PlaybookItemRecord> | null {
		const ordinary = this.authoritativeDetail(id, this.observedDetail(id));
		if (ordinary) return ordinary.item;
		const slot = this.slot,
			result = slot?.confirmation;
		if (
			this.current &&
			this.structure &&
			slot &&
			sameSource(slot, this.structure) &&
			result?.status === 'saved' &&
			result.item._id === id &&
			!slot.detailAccepted
		)
			return result.item;
		return null;
	}
	detailStatus(id: string): 'present' | 'missing' | 'loading' {
		if (this.current && !this.structure!.items.some((item) => item._id === id)) return 'missing';
		return this.authoritativeDetail(id, this.observedDetail(id)) ? 'present' : 'loading';
	}
	acceptSource() {
		const editorId = this.editor?.draft?.persistedId,
			selectedId = this.selectedId,
			request = this.requestedSelection;
		this.editor?.accept();
		if (this.requestedSelection && this.editor?.entry !== this.requestedSelection.entry) {
			this.requestedSelection = null;
			this.selectedId = this.editor?.draft?.persistedId ?? null;
		}
		const resolved = this.openRequestedSelection();
		if (!this.editor?.entry && !this.requestedSelection && this.selectedId) {
			this.selectedId = null;
		}
		if (
			resolved ||
			request !== this.requestedSelection ||
			selectedId !== this.selectedId ||
			editorId !== this.editor?.draft?.persistedId
		)
			this.syncSubscriptions();
	}
	private rememberOpen(itemId: string) {
		if (this.recentIds[0] === itemId) return;
		this.recentIds = [itemId, ...this.recentIds.filter((id) => id !== itemId)].slice(
			0,
			RECENT_ITEMS
		);
		this.rankingDirty = true;
	}
	select(itemId: string, annotationId: string): AnnotationAdmission {
		if (!this.current || itemId.startsWith('pending:')) return { status: 'rejected' };
		const head = this.structure?.items.find((item) => item._id === itemId);
		if (!head) return { status: 'rejected' };
		if (
			this.slot &&
			this.pendingRenderKey === this.structure?.items.find((item) => item._id === itemId)?.renderKey
		)
			return { status: 'rejected' };
		const decision = this.controller.assess({ kind: 'switch-item', itemId });
		if (decision.kind !== 'allowed') {
			this.controller.reportBlocked(decision.message);
			return { status: 'rejected' };
		}
		this.selectedId = itemId;
		this.rememberOpen(itemId);
		if (this.details.get(itemId)?.error) this.releaseDetail(itemId);
		const token = {};
		this.requestedSelection = {
			token,
			itemId,
			annotationId,
			status: 'pending',
			target: head.trigger.target,
			entry: this.controller.entry
		};
		this.openRequestedSelection();
		this.syncSubscriptions();
		return { status: 'accepted', token };
	}
	cancelSelection() {
		if (this.requestedSelection?.status !== 'pending') return false;
		this.requestedSelection = null;
		this.selectedId = this.editor?.draft?.persistedId ?? null;
		this.syncSubscriptions();
		return true;
	}
	private openRequestedSelection() {
		const request = this.requestedSelection;
		if (!request || request.status !== 'pending' || !this.attached || !this.source?.().available)
			return false;
		const status = this.detailStatus(request.itemId);
		if (status === 'loading') return false;
		if (
			status === 'missing' ||
			!this.controller.requestItemSwitch(request.itemId, request.annotationId)
		) {
			this.requestedSelection = null;
			this.selectedId = this.controller.draft?.persistedId ?? null;
			return true;
		}
		this.requestedSelection = { ...request, status: 'opened', entry: this.controller.entry };
		return true;
	}
	private submit(operation: DeepReadonly<Operation>, recovery: AuthoringRecovery) {
		if (!this.canSubmit || !this.structure) return false;
		this.completion = null;
		this.slot = {
			operation: immutable(operation),
			recovery: immutable(recovery),
			templateSourceFingerprint: this.structure.templateSourceFingerprint,
			templateSourceId: this.structure.templateSourceId,
			authoringGeneration: this.structure.authoringGeneration,
			phase: 'saving' as const,
			message: '',
			structureAccepted: false,
			detailAccepted: false
		};
		this.syncSubscriptions();
		void this.send();
		return true;
	}
	async retry() {
		if (this.slot?.phase !== 'uncertain' || !this.available || this.suspended) return;
		this.slot = { ...this.slot, phase: 'saving', message: '' };
		await this.send();
	}
	private async send() {
		const slot = this.slot;
		if (!slot || this.running || slot.phase !== 'saving') return;
		const attempt = (this.attempt = {}),
			generation = this.generation;
		const work = (async () => {
			try {
				const result = await this.transport(slot.operation);
				if (
					this.disposed ||
					generation !== this.generation ||
					attempt !== this.attempt ||
					!this.slot
				)
					return;
				if (result.status === 'saved' || result.status === 'deleted') {
					this.slot = {
						...this.slot,
						templateSourceFingerprint: result.templateSourceFingerprint,
						templateSourceId: result.templateSourceId,
						phase: 'confirmed',
						confirmation: immutable(result),
						message: ''
					};
					this.completion = { kind: result.status };
					this.syncSubscriptions();
					this.reconcile();
				} else {
					this.slot = {
						...this.slot,
						...(result.status === 'conflict' || result.status === 'missing'
							? {
									recoveryWitness: {
										...(result.status === 'conflict'
											? {
													kind: 'conflict' as const,
													itemId: result.item._id,
													minimumContentRevision: result.item.contentRevision
												}
											: { kind: 'missing' as const }),
										watermark: {
											templateSourceFingerprint: result.templateSourceFingerprint,
											templateSourceId: result.templateSourceId,
											authoringGeneration: result.authoringGeneration,
											structuralGeneration: result.structuralGeneration
										}
									}
								}
							: {}),
						phase: 'recovery',
						message:
							result.status === 'rejected'
								? result.message
								: result.status === 'conflict'
									? 'These instructions changed elsewhere. Your submitted draft is retained. Open Template to restore it against the current version.'
									: 'These instructions were deleted. Your submitted draft is retained.'
					};
				}
				this.syncSubscriptions();
			} catch {
				if (generation !== this.generation || attempt !== this.attempt || !this.slot) return;
				this.slot = {
					...this.slot,
					phase: 'uncertain',
					message: 'The connection was interrupted. Retry to confirm the same operation.'
				};
			} finally {
				if (attempt === this.attempt) {
					this.attempt = null;
					this.running = null;
					this.settleLeave();
				}
			}
		})();
		this.running = work;
		await work;
	}
	private reconcile() {
		const slot = this.slot,
			result = slot?.confirmation,
			structure = this.structure;
		if (!slot || slot.phase !== 'confirmed' || !result || !structure?.ready || !this.current)
			return;
		if (!sameSource(structure, result)) {
			// A complete later source observation supersedes the old source, including absence.
			if (structure.authoringGeneration > result.authoringGeneration) this.slot = null;
			this.syncSubscriptions();
			this.settleLeave();
			return;
		}
		if (!watermarkAtLeast(structure, result)) return;
		const id =
			result.status === 'saved'
				? result.item._id
				: slot.operation.kind === 'delete'
					? slot.operation.id
					: undefined;
		const head = structure.items.find((item) => item._id === id);
		const structureAccepted =
			slot.structureAccepted ||
			(result.status === 'deleted'
				? !head
				: !head
					? structure.authoringGeneration > result.authoringGeneration
					: head.contentRevision >= result.item.contentRevision &&
						(head.contentRevision > result.item.contentRevision ||
							(head.renderKey === result.item.renderKey &&
								equalItemStructure(head, playbookStructure(result.item)))));
		const detail = id ? this.authoritativeDetail(id, this.observedDetail(id)) : undefined;
		const detailAccepted =
			slot.detailAccepted ||
			(result.status === 'deleted' || !head
				? structureAccepted
				: Boolean(
						detail &&
						(detail.item.contentRevision > result.item.contentRevision ||
							(detail.item.contentRevision === result.item.contentRevision &&
								detail.item.lastOperation?.id === result.item.lastOperation?.id &&
								detail.item.lastOperation?.callerId === result.item.lastOperation?.callerId &&
								detail.item.currentRevisionId === result.item.currentRevisionId))
					));
		this.slot =
			structureAccepted && detailAccepted ? null : { ...slot, structureAccepted, detailAccepted };
		this.syncSubscriptions();
		this.settleLeave();
	}
	/** Learn identity without ever changing the immutable retry operation. */
	private submissionTarget(): string | undefined {
		const slot = this.slot;
		if (!slot) return;
		const operation = slot.operation;
		const id =
			slot.confirmation?.status === 'saved'
				? slot.confirmation.item._id
				: ((slot.recoveryWitness?.kind === 'conflict' ? slot.recoveryWitness.itemId : undefined) ??
					(operation.kind === 'delete' ? operation.id : operation.request.id) ??
					(this.structure?.ready && operation.kind === 'save'
						? this.structure.items.find((item) => item.renderKey === operation.request.operationId)
								?._id
						: undefined) ??
					slot.learnedTargetId);
		return id;
	}
	private pinnedIds() {
		const ids = new Set<string>();
		if (this.attached) {
			if (this.selectedId) ids.add(this.selectedId);
			const editorId = this.editor?.draft?.persistedId;
			if (editorId) ids.add(editorId);
		}
		const target = this.submissionTarget();
		if (target) ids.add(target);
		return ids;
	}
	private releaseDetail(id: string) {
		const entry = this.details.get(id);
		if (!entry) return;
		this.details.delete(id);
		entry.release?.();
		if (this.pinnedIds().has(id)) this.detailVersion++;
	}
	private resetPreloading() {
		this.nearbyReporter = undefined;
		this.recentIds = [];
		this.nearbyIds = [];
		this.ranking = [];
		this.rankingDirty = true;
		this.failedPreloads.clear();
		this.byteCutoff = Infinity;
		const pins = this.pinnedIds();
		for (const id of this.details.keys()) if (!pins.has(id)) this.releaseDetail(id);
	}
	private updateRanking() {
		if (!this.rankingDirty) return;
		this.rankingDirty = false;
		const members = this.memberIds;
		const current = new Set(members);
		const next = [...new Set([...this.recentIds, ...this.nearbyIds, ...members])].filter((id) =>
			current.has(id)
		);
		if (next.length === this.ranking.length && next.every((id, i) => id === this.ranking[i]))
			return;
		this.ranking = next;
		this.failedPreloads.clear();
		this.byteCutoff = Infinity;
	}
	private syncSubscriptions() {
		if (this.disposed) return;
		if (this.syncing) {
			this.resync = true;
			return;
		}
		this.syncing = true;
		try {
			do {
				this.resync = false;
				this.syncReads();
			} while (this.resync);
		} finally {
			this.syncing = false;
		}
	}
	private syncReads() {
		const needed = this.available && !this.suspended && (this.attached || Boolean(this.slot));
		if (!needed) {
			this.releaseSubscriptions();
			return;
		}
		if (!this.structureRelease) {
			this.structureLoading = true;
			let subscription: () => void;
			this.structureRelease = subscription = this.options.client.onUpdate(
				api.playbookItems.currentStructure,
				{ membershipId: this.options.membershipId, audience: this.options.audience },
				(value) => {
					if (this.disposed || this.structureRelease !== subscription) return;
					// Source/readiness transitions revoke old admission even if a missing pointer
					// reports generation zero. Pending operations retain their own recovery floor.
					if (
						this.structure?.ready &&
						value.ready &&
						sameSource(value, this.structure) &&
						value.authoringGeneration < this.structure.authoringGeneration
					)
						return;
					const members = value.items.map((item) => item._id as string);
					if (
						members.length !== this.memberIds.length ||
						members.some((id, i) => id !== this.memberIds[i])
					) {
						this.memberIds = members;
						this.rankingDirty = true;
					}
					this.structure = immutable({
						...value,
						items: value.items.map(({ audience: _audience, ...item }) => item)
					});
					this.structureError = '';
					this.structureLoading = false;
					this.syncSubscriptions();
					this.reconcile();
				},
				() => {
					if (this.disposed || this.structureRelease !== subscription) return;
					this.structureLoading = false;
					this.structureError = 'Unable to refresh instructions. Your submitted work is retained.';
					this.syncSubscriptions();
					this.settleLeave();
				}
			);
		}
		const pins = new Set(
			[...this.pinnedIds()].filter((id) => this.current && this.memberIds.includes(id))
		);
		const target = this.submissionTarget();
		if (this.slot && target && target !== this.slot.learnedTargetId)
			this.slot = { ...this.slot, learnedTargetId: target };
		const eligible = this.canPreload;
		if (!eligible) this.resetPreloading();
		else {
			if (!this.nearbyReporter) {
				const source = this.source,
					templateSource = this.preloadTemplateSource;
				const report = (ids: readonly string[]) => {
					if (
						this.nearbyReporter !== report ||
						this.source !== source ||
						this.preloadTemplateSource !== templateSource ||
						!this.canPreload
					)
						return;
					if (
						ids.length === this.nearbyIds.length &&
						ids.every((id, i) => id === this.nearbyIds[i])
					)
						return;
					this.nearbyIds = [...ids];
					this.rankingDirty = true;
					this.syncSubscriptions();
				};
				this.nearbyReporter = report;
			}
			this.updateRanking();
		}
		const optional = new Set<string>();
		let bytes = 0,
			awaiting = 0;
		if (eligible) {
			for (let i = 0; i < this.ranking.length && i < this.byteCutoff; i++) {
				const id = this.ranking[i];
				if (pins.has(id) || this.failedPreloads.has(id)) continue;
				const entry = this.details.get(id);
				if (entry?.error) {
					this.failedPreloads.add(id);
					continue;
				}
				if (bytes + (entry?.bytes ?? 0) > PRELOAD_BYTES) {
					this.byteCutoff = i;
					break;
				}
				const pending = !entry || entry.awaiting;
				if (pending && awaiting >= PRELOAD_CONCURRENCY) continue;
				optional.add(id);
				bytes += entry?.bytes ?? 0;
				if (pending) awaiting++;
				if (optional.size === PRELOAD_ITEMS) break;
			}
		}
		for (const id of this.details.keys())
			if (!pins.has(id) && !optional.has(id)) this.releaseDetail(id);
		// Foreground dispatch is independent of the optional first-result pump.
		for (const id of pins) this.subscribeDetail(id);
		for (const id of optional) this.subscribeDetail(id);
	}
	private subscribeDetail(id: string) {
		if (this.details.has(id)) return;
		const entry: DetailSubscription = { awaiting: true, bytes: 0 };
		this.details.set(id, entry);
		entry.release = this.options.client.onUpdate(
			api.playbookItems.content,
			{
				membershipId: this.options.membershipId,
				id: id as Id<'playbookItems'>,
				audience: this.options.audience
			},
			(raw) => {
				const value = raw.status === 'present' ? { ...raw, item: authoringRecord(raw.item) } : raw;
				if (this.disposed || this.details.get(id) !== entry) return;
				const prior = entry.snapshot;
				if (
					prior?.status === 'present' &&
					value.status === 'present' &&
					sameSource(prior, value) &&
					value.item.contentRevision < prior.item.contentRevision
				)
					return;
				const sameBody =
					prior?.status === 'present' &&
					value.status === 'present' &&
					sameSource(prior, value) &&
					prior.ready === value.ready &&
					prior.item.renderKey === value.item.renderKey &&
					prior.item.currentRevisionId === value.item.currentRevisionId &&
					prior.item._creationTime === value.item._creationTime &&
					prior.item.contentRevision === value.item.contentRevision;
				if (!sameBody)
					entry.bytes =
						value.status === 'present'
							? new TextEncoder().encode(JSON.stringify(value.item)).byteLength
							: 0;
				entry.snapshot = sameBody ? prior : immutable(value);
				this.failedPreloads.delete(id);
				entry.awaiting = false;
				entry.error = undefined;
				if (this.pinnedIds().has(id)) {
					this.detailVersion++;
					this.reconcile();
					this.openRequestedSelection();
				}
				this.syncSubscriptions();
			},
			() => {
				if (this.disposed || this.details.get(id) !== entry) return;
				entry.awaiting = false;
				entry.snapshot = undefined;
				entry.bytes = 0;
				if (this.pinnedIds().has(id)) {
					entry.error =
						'Unable to load these instructions. Retry the refresh or select the clause again.';
					this.detailVersion++;
					this.settleLeave();
				} else {
					this.failedPreloads.add(id);
					this.releaseDetail(id);
				}
				this.syncSubscriptions();
			}
		);
	}
	/** Resolve both button readiness and execution against the same current authority. */
	private recoveryContext(): {
		slot: Submission;
		current: DeepReadonly<PlaybookItemRecord> | null;
	} | null {
		if (
			!this.slot ||
			this.slot.phase !== 'recovery' ||
			!this.attached ||
			!this.current ||
			this.frozen ||
			!this.source?.().available
		)
			return null;
		const id = this.submissionTarget(),
			slot = this.slot,
			structure = this.structure!;
		const witness = slot.recoveryWitness;
		// A fallback server watermark cannot weaken the submission's observed timeline.
		for (const authority of witness ? [slot, witness.watermark] : [slot]) {
			if (sameSource(structure, authority)) {
				if (structure.authoringGeneration < authority.authoringGeneration) return null;
			} else if (structure.authoringGeneration <= authority.authoringGeneration) return null;
		}
		if (!id) return { slot, current: null };
		const detail = this.authoritativeDetail(id, this.observedDetail(id)),
			head = structure.items.find((item) => item._id === id);
		if (witness && sameSource(structure, witness.watermark)) {
			if (witness.kind === 'missing' && head) return null;
			if (
				witness.kind === 'conflict' &&
				!head &&
				structure.authoringGeneration <= witness.watermark.authoringGeneration
			)
				return null;
		}
		if (!head) return { slot, current: null };
		const floor =
			witness?.kind === 'conflict'
				? witness.minimumContentRevision
				: slot.operation.kind === 'save'
					? slot.operation.request.expectedContentRevision
					: slot.operation.expectedContentRevision;
		if (!detail || detail.item.contentRevision < floor) return null;
		return { slot, current: detail.item };
	}
	restore(replaceDraft = false) {
		const context = this.recoveryContext();
		if (!context || (this.controller.hasUnsavedWork && !replaceDraft)) return false;
		this.controller.restore(context.slot.recovery, context.current);
		if (context.current) this.rememberOpen(context.current._id);
		this.slot = null;
		this.requestedSelection = null;
		this.selectedId = context.current?._id ?? null;
		this.syncSubscriptions();
		return true;
	}
	get recoveryCanRestore() {
		return Boolean(this.recoveryContext());
	}
	discardRecovery() {
		if (this.slot?.phase === 'recovery') {
			this.slot = null;
			this.syncSubscriptions();
		}
	}
	private async prepareToLeave() {
		const generation = this.generation;
		if (this.running) await this.running;
		if (generation !== this.generation) return false;
		if (this.slot?.phase !== 'confirmed' || this.structureError || this.detailError)
			return !this.pending;
		return new Promise<boolean>((resolve) => {
			const check = () => {
				if (
					generation === this.generation &&
					this.slot?.phase === 'confirmed' &&
					!this.structureError &&
					!this.detailError
				)
					return;
				this.leaveWaiters.delete(check);
				resolve(generation === this.generation && !this.pending);
			};
			this.leaveWaiters.add(check);
			check();
		});
	}
	private settleLeave() {
		for (const check of [...this.leaveWaiters]) check();
	}
	private restartTransport() {
		this.generation++;
		this.attempt = null;
		this.running = null;
		if (this.slot?.phase === 'saving')
			this.slot = {
				...this.slot,
				phase: 'uncertain',
				message: 'The connection changed. Retry to confirm this operation.'
			};
		this.releaseSubscriptions();
		this.syncSubscriptions();
		this.settleLeave();
	}
	discard() {
		this.generation++;
		this.attempt = null;
		this.running = null;
		this.slot = null;
		this.requestedSelection = null;
		this.selectedId = null;
		this.editor?.discard();
		this.completion = null;
		this.syncSubscriptions();
		this.settleLeave();
	}
	retryReads() {
		this.releaseSubscriptions();
		this.syncSubscriptions();
	}
	private releaseSubscriptions() {
		this.resetPreloading();
		const release = this.structureRelease;
		this.structureRelease = undefined;
		this.structureLoading = true;
		release?.();
		for (const id of this.details.keys()) this.releaseDetail(id);
	}
	destroy() {
		this.disposed = true;
		this.discard();
		this.releaseSubscriptions();
		this.unregister?.();
		this.source = null;
		this.details.clear();
		this.projectedDetails = [];
	}
}
const key = Symbol('template-authoring-session');
export const setTemplateAuthoringSession = (
	session: TemplateAuthoringSession,
	audience: InstructionAudience = 'rep'
) => setContext(audience === 'buyer' ? buyerKey : key, session);
const buyerKey = Symbol('buyer-template-authoring-session');
export const getTemplateAuthoringSession = (audience: InstructionAudience = 'rep') =>
	getContext<TemplateAuthoringSession>(audience === 'buyer' ? buyerKey : key);
