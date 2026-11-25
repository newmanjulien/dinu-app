import type { DeepReadonly } from '$lib/immutable';
import type {
	AnnotationAdmission,
	AuthoringSelectionRequest
} from '$lib/playbook/authoring-selection';
import { concessionSelectionMap } from '$lib/contract/changes';
import type { ReviewDecision, ReviewNavigation, ReviewTag } from '$lib/contract/approval';
import type { ReadyContract } from '$lib/contract/saved';
import { getContractOpenings } from '$lib/contract/snapshot-cache';
import {
	isRepItem,
	sameSelection,
	type ContractChange,
	type SourceTarget
} from '$lib/playbook/model';
import type { Snippet } from 'svelte';
import { getContext, setContext, untrack } from 'svelte';
import type { DocumentLayoutProfiles } from './layout-context.svelte';
import { recordColdStart } from './render-perf';
import type { DocumentSectionHandle } from './section.svelte';
import type { DocumentSourceInput } from './source.svelte';
import { type ConcessionSelection } from './types';
import type { DocumentWorkspace } from './workspace-context';
import type { createDocumentWorkspace } from './workspace-factory';

function selectedOptions(data: ReadyContract): Record<string, string> {
	return concessionSelectionMap(data.contract.concessions);
}
function contractInput(data: ReadyContract): DocumentSourceInput {
	return {
		kind: 'records',
		contract: true,
		blocks: { data: data.snapshot.blocks },
		items: { data: data.snapshot.items.filter(isRepItem) }
	};
}

const isTemplateResource = (id: string) => id === 'template' || id === 'template:buyer';

export interface ViewerBindings {
	reserveReviewGutter?: boolean;
	onRetry?: () => void;
	failure?: { message: string };
	onPresentation?: (
		outcome: import('$lib/auth/workspace-presentation.svelte').PresentationOutcome
	) => void;
	active?: boolean;
	/** Whether this binding is the route's intended foreground viewer. */
	foreground?: boolean;
	prepare?: boolean;
	/** Demand only; item bodies and subscriptions belong to the authoring session. */
	itemPreload?: (ids: readonly string[]) => void;
	reviewTags?: readonly ReviewTag[];
	reviewNavigation?: ReviewNavigation;
	onItemIntent?: (itemId: string) => void;
	onReviewDecision?: (tag: ReviewTag, status: ReviewDecision) => void;
	panelContent: Snippet;
	footerContent?: Snippet;
	selectedConcessions: ConcessionSelection;
	hasPanel?: boolean;
	interactive?: boolean;
	annotationsVisible?: boolean;
	followScroll?: boolean;
	selectedAnnotationId?: string | null;
	selectionRequest?: AuthoringSelectionRequest | null;
	selectedRanges?: readonly SourceTarget[];
	previewChanges?: DeepReadonly<ContractChange[]>;
	/** The selected clause's stable source target; click position is intentionally not retained here. */
	panelTarget?: SourceTarget;
	picking?: boolean;
	/** Whether this document offers playbook navigation, independent of temporary readiness. */
	allowPlaybookNavigation?: boolean;
	sourceSelectionEnabled?: boolean;
	allowBoundarySelection?: boolean;
	/** Additional action guard; does not remove mounted button semantics or focus. */
	playbookNavigationReady?: boolean;
	onRemoveConcession?: (itemId: string) => void;
	onSelect: (itemId: string, annotationId: string) => AnnotationAdmission | boolean | void;
	/** A resolved click on ordinary document content, after selection/drag classification. */
	onDocumentBackground?: () => void;
}
export interface DocumentAttachment {
	readonly entry: DocumentResource;
	bind: (
		bindings: ViewerBindings,
		target: HTMLElement | undefined,
		section: DocumentSectionHandle
	) => () => void;
	update: (choices: ConcessionSelection) => void;
	release: () => void;
}
/** One route binding owns its target, section, and any physical placement claim. */
export interface DocumentAttachmentBinding {
	readonly bindings: ViewerBindings;
	readonly target: HTMLElement | undefined;
	readonly section: DocumentSectionHandle;
	place: (wrapper: HTMLElement) => void;
	unplace: (wrapper: HTMLElement) => void;
}
export interface DocumentPlacement {
	readonly binding: DocumentAttachmentBinding;
	readonly wrapper: HTMLElement;
	readonly section: DocumentSectionHandle;
	readonly target: HTMLElement;
}
function sameOrder<T>(a: readonly T[], b: readonly T[]) {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}
export class DocumentResource {
	readonly owner = Symbol('document-resource');
	readonly workspace: DocumentWorkspace;
	attachmentBinding = $state.raw<DocumentAttachmentBinding>();
	placement = $state.raw<DocumentPlacement>();
	get bindings() {
		return this.attachmentBinding?.bindings;
	}
	get target() {
		return this.attachmentBinding?.target;
	}
	active = $state(false);
	opening = $state(false);
	allowed = $state(false);
	choices = $state.raw<ConcessionSelection>({});
	confirmedChoices: ConcessionSelection = {};
	lastUsed = 0;
	completed = false;
	readonly priority = () =>
		this.active || this.opening ? ('foreground' as const) : ('background' as const);
	id = $state('');
	get reserveReviewGutter(): boolean {
		return !isTemplateResource(this.id);
	}
	constructor(
		id: string,
		input: DocumentSourceInput,
		createWorkspace: typeof createDocumentWorkspace
	) {
		this.id = id;
		this.workspace = createWorkspace(input);
	}
	destroy() {
		this.allowed = false;
		this.active = false;
		this.opening = false;
		this.placement = undefined;
		this.attachmentBinding = undefined;
		this.workspace.renderer.destroy();
		this.workspace.source.destroy?.();
	}
}
const RESOURCES = Symbol('document-resources');

/** Layout-owned document work; route-owned interaction bindings never outlive their route. */
export class DocumentResources {
	private readonly openings = getContractOpenings();
	entries = $state.raw<readonly DocumentResource[]>([]);
	active = $state.raw<DocumentResource>();
	warming = $state(true);
	backgroundEnabled = $state(false);
	paused = $state(false);
	#candidates = $state.raw<readonly string[]>([]);
	#pending = $state.raw<
		readonly {
			data: ReadyContract;
			input: DocumentSourceInput;
			choices: ConcessionSelection;
		}[]
	>([]);
	#leases = $state.raw<ReadonlyMap<string, { count: number }>>(new Map());
	#canConstruct = $state(false);
	#rank: readonly string[] = [];
	#preparationBudget = 0;
	#failed = new Set<string>();
	#clock = 0;
	#destroyed = false;
	#attachments = new Map<DocumentResource, DocumentAttachment>();
	#release: () => void;
	#getCreateWorkspace: () => typeof createDocumentWorkspace | undefined;
	get preparationCandidates() {
		return this.#candidates;
	}
	constructor(
		readonly profiles: DocumentLayoutProfiles,
		getCreateWorkspace: () => typeof createDocumentWorkspace | undefined
	) {
		this.#getCreateWorkspace = getCreateWorkspace;
		this.#release = $effect.root(() => {
			$effect(() => {
				const profiler = profiles.profiler;
				const backgroundEnabled = this.backgroundEnabled;
				const paused = this.paused;
				const createWorkspace = this.#getCreateWorkspace();
				const states = this.entries.map((entry) => ({
					entry,
					active: entry.active,
					opening: entry.opening,
					pages: entry.workspace.renderer.retainedPageCount,
					failed: Boolean(
						entry.workspace.renderer.error ||
						entry.workspace.source.issue ||
						entry.workspace.viewer.preparationBlocked
					),
					prepared:
						entry.workspace.viewer.layoutPrepared &&
						Boolean(
							profiler &&
							entry.workspace.source.renderSource &&
							entry.workspace.renderer.isCurrent({
								source: entry.workspace.source.renderSource,
								concessions: entry.bindings?.selectedConcessions ?? entry.choices,
								previewChanges: entry.active ? entry.bindings?.previewChanges : undefined,
								profiler
							})
						)
				}));
				const candidates = this.#candidates;
				const pending = this.#pending;
				const openingPending = pending.some(({ data }) => this.#leases.has(data.id));
				untrack(() => {
					for (const state of states) if (state.prepared) state.entry.completed = true;
					for (const state of states)
						if (state.failed && !state.active && !state.opening) {
							this.failedPreparation(state.entry.id);
						}
					if (candidates !== this.#candidates) return;
					const foregroundBusy = states.some(
						(state) => (state.active || state.opening) && !state.prepared && !state.failed
					);
					const nextId = candidates.find(
						(id) =>
							!this.#failed.has(id) &&
							!states.some((state) => state.entry.id === id && state.prepared)
					);
					const constructing = pending.some(({ data }) => data.id === nextId);
					const savedBusy =
						foregroundBusy ||
						candidates.some(
							(id) =>
								!this.#failed.has(id) &&
								!states.some((state) => state.entry.id === id && state.prepared)
						);
					for (const state of states) {
						state.entry.allowed =
							!paused &&
							(state.active ||
								state.opening ||
								(backgroundEnabled &&
									!isTemplateResource(state.entry.id) &&
									(state.prepared || (!foregroundBusy && state.entry.id === nextId))));
					}
					this.#canConstruct =
						Boolean(createWorkspace) &&
						!paused &&
						(openingPending || (backgroundEnabled && !foregroundBusy && constructing));
					this.warming = savedBusy;
					this.#trim();
				});
			});
			$effect(() => {
				const profiler = profiles.profiler;
				const pending = this.#pending;
				const next =
					pending.find(({ data }) => this.#leases.has(data.id)) ??
					this.#candidates
						.map((id) => pending.find(({ data }) => data.id === id))
						.find((value) => value !== undefined);
				if (!this.#canConstruct || !profiler || !next) return;
				const { data, input, choices } = next;
				const abort = new AbortController();
				void profiler.scheduler
					.run(
						() => (this.#leases.has(data.id) ? 'foreground' : 'background'),
						() =>
							untrack(() => {
								if (
									this.#destroyed ||
									!this.#canConstruct ||
									profiles.profiler !== profiler ||
									!this.#pending.includes(next) ||
									(!this.#leases.has(data.id) && !this.#candidates.includes(data.id))
								)
									return;
								const entry = this.acquireContract(data, input);
								this.update(entry, choices);
								entry.allowed = true;
								this.#trim();
							}),
						abort.signal
					)
					.catch(() => {});
				return () => abort.abort();
			});
		});
	}
	acquire(id: string, input: DocumentSourceInput): DocumentResource {
		if (this.#pending.some(({ data }) => data.id === id))
			this.#pending = this.#pending.filter(({ data }) => data.id !== id);
		let entry = this.entries.find((entry) => entry.id === id);
		if (!entry) {
			if (!isTemplateResource(id)) this.#makeRoom(id);
			const createWorkspace = this.#getCreateWorkspace();
			if (!createWorkspace) throw new Error('Document workspace is not loaded.');
			entry = new DocumentResource(id, input, createWorkspace);
			entry.opening = this.#leases.has(id);
			entry.allowed = entry.opening && !this.paused;
			this.entries = [...this.entries, entry];
		} else entry.workspace.accept(input);
		entry.lastUsed = ++this.#clock;
		return entry;
	}
	acquireContract(data: ReadyContract, input: DocumentSourceInput = contractInput(data)) {
		const entry = this.acquire(data.id, input);
		entry.confirmedChoices = selectedOptions(data);
		if (!entry.active) this.update(entry, entry.confirmedChoices);
		return entry;
	}
	update(entry: DocumentResource, choices: ConcessionSelection) {
		if (!sameSelection(entry.choices, choices)) entry.choices = Object.freeze({ ...choices });
	}
	hasOpening(id: string) {
		return this.#leases.has(id);
	}
	/** A retained document can be shown alongside Help without waiting for another paint. */
	isPreparedContract(id: string, choices: ConcessionSelection) {
		const entry = this.entries.find((entry) => entry.id === id);
		const profiler = this.profiles.profiler;
		const source = entry?.workspace.source.renderSource;
		return Boolean(
			entry?.workspace.viewer.layoutPrepared &&
			profiler &&
			source &&
			entry.workspace.renderer.isCurrent({ source, concessions: choices, profiler })
		);
	}
	/** Keyed ownership also protects a resource constructed after module/host admission. */
	beginOpen(id: string) {
		if (this.#destroyed) return () => {};
		const lease = this.#leases.get(id) ?? { count: 0 };
		lease.count++;
		this.#leases = new Map(this.#leases).set(id, lease);
		const entry = this.entries.find((entry) => entry.id === id);
		if (entry) {
			entry.opening = true;
			entry.allowed = !this.paused;
		}
		this.#failed.delete(id);
		this.profiles.scheduler.wake();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (this.#destroyed || this.#leases.get(id) !== lease) return;
			lease.count--;
			const leases = new Map(this.#leases);
			if (!lease.count) leases.delete(id);
			this.#leases = leases;
			const current = this.entries.find((entry) => entry.id === id);
			if (current) current.opening = lease.count > 0;
			this.candidates(this.#rank);
			this.#trim();
		};
	}
	activate(
		entry: DocumentResource,
		choices: ConcessionSelection = entry.choices
	): DocumentAttachment {
		const previous = this.active && this.#attachments.get(this.active);
		const owns = () => !this.#destroyed && this.#attachments.get(entry) === attachment;
		const attachment: DocumentAttachment = {
			entry,
			bind: (bindings, target, section) => {
				if (!owns()) return () => {};
				const binding: DocumentAttachmentBinding = {
					bindings,
					target,
					section,
					place: (wrapper) => {
						if (
							!owns() ||
							entry.attachmentBinding !== binding ||
							!target ||
							!section.viewport?.contains(target) ||
							wrapper.parentElement !== target
						)
							return;
						entry.placement = { binding, wrapper, section, target };
					},
					unplace: (wrapper) => {
						const placement = untrack(() => entry.placement);
						if (placement?.binding === binding && placement.wrapper === wrapper)
							entry.placement = undefined;
					}
				};
				entry.placement = undefined;
				entry.attachmentBinding = binding;
				return () => {
					if (!owns() || untrack(() => entry.attachmentBinding) !== binding) return;
					entry.placement = undefined;
					entry.attachmentBinding = undefined;
				};
			},
			update: (next) => {
				if (owns()) this.update(entry, next);
			},
			release: () => {
				if (!owns()) return;
				entry.placement = undefined;
				entry.attachmentBinding = undefined;
				this.#attachments.delete(entry);
				this.deactivate(entry);
			}
		};
		this.#attachments.set(entry, attachment);
		this.update(entry, choices);
		this.active = entry;
		entry.active = true;
		entry.allowed = true;
		// Protect the incoming owner before releasing an attachment that may trim resources.
		// On the same entry, replacing the map token makes the old cleanup inert.
		if (previous && previous.entry !== entry) previous.release();
		entry.placement = undefined;
		entry.attachmentBinding = undefined;
		entry.lastUsed = ++this.#clock;
		this.#failed.delete(entry.id);
		const profiler = this.profiles.profiler;
		if (
			entry.workspace.viewer.layoutPrepared &&
			profiler &&
			entry.workspace.source.renderSource &&
			entry.workspace.renderer.isCurrent({
				source: entry.workspace.source.renderSource,
				concessions: entry.choices,
				profiler
			})
		)
			recordColdStart('prepared-document-acquired');
		else recordColdStart('unprepared-document-acquired');
		this.profiles.scheduler.wake();
		this.#trim();
		return attachment;
	}
	private deactivate(entry: DocumentResource) {
		entry.active = false;
		if (isTemplateResource(entry.id)) entry.allowed = false;
		entry.placement = undefined;
		entry.attachmentBinding = undefined;
		entry.workspace.viewer.interactionEnabled = false;
		entry.workspace.viewer.pagesVisible = false;
		entry.workspace.viewer.firstPagesReady = null;
		if (this.active === entry) this.active = undefined;
		this.update(entry, isTemplateResource(entry.id) ? {} : entry.confirmedChoices);
		this.#trim();
	}
	candidates(ranked: readonly string[], budget = this.#preparationBudget) {
		if (!sameOrder(this.#rank, ranked)) this.#rank = [...ranked];
		this.#preparationBudget = budget;
		const recent = this.openings
			.read()
			.find((opening) => this.entries.some((entry) => entry.id === opening.id))?.id;
		const reserved = this.entries
			.filter(
				(entry) =>
					!isTemplateResource(entry.id) && (entry.active || entry.opening || entry.id === recent)
			)
			.map((entry) => entry.id);
		const ids = ranked
			.filter((id) => !this.#failed.has(id) && (reserved.includes(id) || reserved.length < 4))
			.slice(0, budget);
		if (!sameOrder(this.#candidates, ids)) this.#candidates = [...ids];
		const pending = this.#pending.filter(
			({ data }) => this.#leases.has(data.id) || ids.includes(data.id)
		);
		if (!sameOrder(this.#pending, pending)) this.#pending = pending;
		for (const id of this.#failed)
			if (!isTemplateResource(id) && !ranked.includes(id)) this.#failed.delete(id);
		for (const entry of this.entries)
			if (
				!isTemplateResource(entry.id) &&
				!entry.active &&
				!entry.opening &&
				!ids.includes(entry.id) &&
				!entry.completed
			)
				this.evict(entry.id);
		// Reorder candidate dispatch without changing mounted component identities.
		const entries = [...this.entries].sort(
			(a, b) =>
				(ids.includes(a.id) ? ids.indexOf(a.id) : ids.length) -
				(ids.includes(b.id) ? ids.indexOf(b.id) : ids.length)
		);
		if (!sameOrder(this.entries, entries)) this.entries = entries;
	}
	/** Explicit interaction may retry a candidate suppressed by background failure or eviction. */
	promote(id: string) {
		this.#failed.delete(id);
	}
	prepare(
		data: ReadyContract,
		input?: DocumentSourceInput,
		choices: ConcessionSelection = selectedOptions(data)
	) {
		if (this.#destroyed) return;
		const entry = this.entries.find((entry) => entry.id === data.id);
		if (entry) entry.confirmedChoices = selectedOptions(data);
		if (entry) {
			if (!entry.active) {
				entry.workspace.accept(input ?? contractInput(data));
				this.update(entry, choices);
			}
			return;
		}
		if (
			!this.#leases.has(data.id) &&
			(this.#failed.has(data.id) || !this.#candidates.includes(data.id))
		)
			return;
		const pending = this.#pending.find(({ data: pending }) => pending.id === data.id);
		if (
			pending?.data === data &&
			(!input || pending.input === input) &&
			sameSelection(pending.choices, choices)
		)
			return;
		const next = { data, input: input ?? contractInput(data), choices };
		if (pending) this.#pending = this.#pending.map((value) => (value === pending ? next : value));
		else this.#pending = [...this.#pending, next];
	}
	failedPreparation(id: string) {
		this.#failed.add(id);
		const entry = this.entries.find((entry) => entry.id === id);
		if (entry && !entry.active && !entry.opening) this.evict(id);
		this.candidates(this.#rank);
	}
	remove(id: string) {
		const leases = new Map(this.#leases);
		leases.delete(id);
		this.#leases = leases;
		this.evict(id);
		this.candidates(this.#rank.filter((candidate) => candidate !== id));
	}

	evict(id: string) {
		if (this.#pending.some(({ data }) => data.id === id))
			this.#pending = this.#pending.filter(({ data }) => data.id !== id);
		const entry = this.entries.find((entry) => entry.id === id);
		if (!entry) return;
		this.entries = this.entries.filter((current) => current !== entry);
		if (this.active === entry) this.active = undefined;
		entry.destroy();
		this.#attachments.delete(entry);
		recordColdStart('document-resource-evicted');
	}
	#removable(saved: readonly DocumentResource[]) {
		const recent = this.openings.read()[0]?.id;
		const rank = (entry: DocumentResource) => {
			const index = this.#rank.indexOf(entry.id);
			return entry.id === recent ? -1 : index < 0 ? Number.MAX_SAFE_INTEGER : index;
		};
		return saved
			.filter((entry) => !entry.active && !entry.opening)
			.sort((a, b) => rank(b) - rank(a) || a.lastUsed - b.lastUsed);
	}
	#makeRoom(id: string) {
		const saved = this.entries.filter((entry) => !isTemplateResource(entry.id));
		if (saved.length < 4) return;
		const victim = this.#removable(saved).find((entry) => entry.id !== id);
		if (victim) {
			const candidate = this.#candidates.includes(victim.id);
			if (candidate) this.#failed.add(victim.id);
			this.evict(victim.id);
			if (candidate) this.candidates(this.#rank);
		}
	}
	#trim() {
		let evicted = false;
		const saved = this.entries.filter((entry) => !isTemplateResource(entry.id));
		const removable = this.#removable(saved);
		let count = saved.length;
		let pages = removable.reduce(
			(sum, entry) => sum + entry.workspace.renderer.retainedPageCount,
			0
		);
		for (const entry of removable) {
			if (count <= 4 && pages <= 60) break;
			count--;
			pages -= entry.workspace.renderer.retainedPageCount;
			this.#failed.add(entry.id); // Data remains cached; navigation can still acquire it.
			this.evict(entry.id);
			evicted = true;
		}
		if (evicted) this.candidates(this.#rank);
	}
	destroy() {
		this.#destroyed = true;
		this.#release();
		for (const entry of this.entries) entry.destroy();
		this.entries = [];
		this.active = undefined;
		this.#pending = [];
		this.#attachments.clear();
		this.#leases = new Map();
	}
}
export function setDocumentResources(resources: DocumentResources) {
	return setContext(RESOURCES, resources);
}
export function getDocumentResources(): DocumentResources | undefined {
	return getContext(RESOURCES);
}
