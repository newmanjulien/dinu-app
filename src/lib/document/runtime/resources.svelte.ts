import { getContext, setContext, untrack } from 'svelte';
import type { Snippet } from 'svelte';
import type { ReviewTag, ReviewDecision, ReviewNavigation } from '$lib/contract/approval';
import type { ContractChange, SourcePoint, SourceRange } from '$lib/playbook/model';
import type { ContractSnapshotResult } from '$lib/contract/saved';
import type { ContractSourceInput } from './source.svelte';
import type { createContractWorkspace, ContractWorkspace } from './context';
import type { ContractLayoutProfiles } from './layout-context.svelte';
import { recordColdStart } from './render-perf';
import { recentOpenings } from '$lib/contract/browser-storage';
import { sameSelection } from '$lib/playbook/model';
import { type ConcessionSelection } from './types';

export interface ViewerBindings {
	active?: boolean;
	prepare?: boolean;
	reviewTags?: readonly ReviewTag[];
	/** Reserved by the workspace before document pagination or review-tag projection. */
	reviewGutter?: number;
	reviewNavigation?: ReviewNavigation;
	onReviewDecision?: (tag: ReviewTag, status: ReviewDecision) => void;
	panelContent: Snippet;
	footerContent?: Snippet;
	selectedConcessions: ConcessionSelection;
	hasPanel?: boolean;
	interactive?: boolean;
	followScroll?: boolean;
	selectedAnnotationId?: string | null;
	selectedRanges?: readonly SourceRange[];
	previewChanges?: readonly ContractChange[];
	panelSource?: SourcePoint;
	picking?: boolean;
	/** Whether this document offers playbook navigation, independent of temporary readiness. */
	allowPlaybookNavigation?: boolean;
	/** Additional action guard; does not remove mounted button semantics or focus. */
	playbookNavigationReady?: boolean;
	onRemoveConcession: (itemId: string) => void;
	onSelect: (itemId: string, annotationId: string) => boolean | void;
}
export interface DocumentAttachment {
	readonly entry: DocumentResource;
	bind: (bindings: ViewerBindings, target?: HTMLElement) => () => void;
	update: (choices: ConcessionSelection) => void;
	release: () => void;
}
function sameOrder<T>(a: readonly T[], b: readonly T[]) {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}
export type ReadyContract = Extract<ContractSnapshotResult, { status: 'ready' }>;
export class DocumentResource {
	readonly owner = Symbol('document-resource');
	readonly workspace: ContractWorkspace;
	bindings = $state.raw<ViewerBindings>();
	target = $state<HTMLElement>();
	active = $state(false);
	draftOwned = $state(false);
	opening = $state(false);
	openings = 0;
	allowed = $state(false);
	choices = $state.raw<ConcessionSelection>({});
	confirmedChoices: ConcessionSelection = {};
	lastUsed = 0;
	completed = false;
	readonly priority = () =>
		this.active || this.opening || this.draftOwned
			? ('foreground' as const)
			: ('background' as const);
	id = $state('');
	constructor(
		id: string,
		input: ContractSourceInput,
		createWorkspace: typeof createContractWorkspace
	) {
		this.id = id;
		this.workspace = createWorkspace(input);
	}
	destroy() {
		this.allowed = false;
		this.active = false;
		this.opening = false;
		this.openings = 0;
		this.target = undefined;
		this.bindings = undefined;
		this.workspace.renderer.destroy();
	}
}
const RESOURCES = Symbol('document-resources');

/** Layout-owned document work; route-owned interaction bindings never outlive their route. */
export class DocumentResources {
	entries = $state.raw<readonly DocumentResource[]>([]);
	active = $state.raw<DocumentResource>();
	warming = $state(true);
	backgroundEnabled = $state(false);
	paused = $state(false);
	createWorkspace = $state.raw<typeof createContractWorkspace>();
	#candidates = $state.raw<readonly string[]>([]);
	#pending = $state.raw<readonly ReadyContract[]>([]);
	#canConstruct = $state(false);
	#rank: readonly string[] = [];
	#preparationBudget = 0;
	#failed = new Set<string>();
	#clock = 0;
	#destroyed = false;
	#attachments = new Map<DocumentResource, DocumentAttachment>();
	#release: () => void;
	get preparationCandidates() {
		return this.#candidates;
	}
	constructor(readonly profiles: ContractLayoutProfiles) {
		this.#release = $effect.root(() => {
			$effect(() => {
				const profiler = profiles.profiler;
				const backgroundEnabled = this.backgroundEnabled;
				const paused = this.paused;
				const createWorkspace = this.createWorkspace;
				const states = this.entries.map((entry) => ({
					entry,
					active: entry.active,
					opening: entry.opening,
					draftOwned: entry.draftOwned,
					pages: entry.workspace.renderer.retainedPageCount,
					failed: Boolean(
						entry.workspace.renderer.error ||
						entry.workspace.source.issue ||
						entry.workspace.viewer.preparationBlocked
					),
					prepared:
						entry.workspace.viewer.prepared &&
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
				untrack(() => {
					for (const state of states) if (state.prepared) state.entry.completed = true;
					for (const state of states)
						if (state.failed && !state.active && !state.opening && !state.draftOwned) {
							this.failedPreparation(state.entry.id);
						}
					if (candidates !== this.#candidates) return;
					const foregroundBusy = states.some(
						(state) =>
							(state.active || state.opening || state.draftOwned) &&
							!state.prepared &&
							!state.failed
					);
					const nextId = candidates.find(
						(id) =>
							!this.#failed.has(id) &&
							!states.some((state) => state.entry.id === id && state.prepared)
					);
					const constructing = pending.some((data) => data.id === nextId);
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
								state.draftOwned ||
								(backgroundEnabled &&
									state.entry.id !== 'admin' &&
									(state.prepared || (!foregroundBusy && state.entry.id === nextId))));
					}
					this.#canConstruct =
						Boolean(createWorkspace) &&
						!paused &&
						backgroundEnabled &&
						!foregroundBusy &&
						constructing;
					this.warming = savedBusy;
					this.#trim();
				});
			});
			$effect(() => {
				const profiler = profiles.profiler;
				const pending = this.#pending;
				const data = this.#candidates
					.map((id) => pending.find((data) => data.id === id))
					.find((data) => data !== undefined);
				if (!this.#canConstruct || !profiler || !data) return;
				const abort = new AbortController();
				void profiler.scheduler
					.run(
						() => 'background',
						() =>
							untrack(() => {
								if (
									this.#destroyed ||
									!this.#canConstruct ||
									profiles.profiler !== profiler ||
									!this.#pending.includes(data) ||
									!this.#candidates.includes(data.id)
								)
									return;
								const entry = this.acquireContract(data);
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
	acquire(id: string, input: ContractSourceInput): DocumentResource {
		if (this.#pending.some((data) => data.id === id))
			this.#pending = this.#pending.filter((data) => data.id !== id);
		let entry = this.entries.find((entry) => entry.id === id);
		if (!entry) {
			if (id !== 'admin') this.#makeRoom(id);
			if (!this.createWorkspace) throw new Error('Document rendering is not loaded.');
			entry = new DocumentResource(id, input, this.createWorkspace);
			this.entries = [...this.entries, entry];
		} else entry.workspace.accept(input);
		entry.lastUsed = ++this.#clock;
		return entry;
	}
	createDraft(input: ContractSourceInput) {
		const entry = this.acquire(`draft:${++this.#clock}`, input);
		entry.draftOwned = true;
		entry.allowed = true;
		return entry;
	}
	/** Associate a confirmed contract with the same workspace, viewer and page elements. */
	adopt(entry: DocumentResource, data: ReadyContract) {
		if (!this.entries.includes(entry) || !entry.draftOwned)
			throw new Error('Draft is unavailable.');
		const existing = this.entries.find((current) => current !== entry && current.id === data.id);
		if (existing) this.evict(existing.id);
		entry.workspace.accept({
			blocks: { data: data.snapshot.blocks },
			items: { data: data.snapshot.items }
		});
		entry.id = data.id;
		entry.confirmedChoices = data.contract.selectedConcessions;
		this.update(entry, entry.confirmedChoices);
		// The mounted viewer owns the render mode and its first-page paint handshake.
		if (entry.workspace.renderer.error) entry.workspace.viewer.retry?.();
	}
	releaseDraft(entry: DocumentResource) {
		entry.draftOwned = false;
		if (entry.id.startsWith('draft:')) this.evict(entry.id);
		else this.#trim();
	}
	acquireContract(data: ReadyContract) {
		const entry = this.acquire(data.id, {
			blocks: { data: data.snapshot.blocks },
			items: { data: data.snapshot.items }
		});
		entry.confirmedChoices = data.contract.selectedConcessions;
		if (!entry.active) this.update(entry, entry.confirmedChoices);
		return entry;
	}
	update(entry: DocumentResource, choices: ConcessionSelection) {
		if (!sameSelection(entry.choices, choices)) entry.choices = Object.freeze({ ...choices });
	}
	/** Called after navigation guards pass, before Home releases its candidates. */
	beginOpen(id: string) {
		const entry = this.entries.find((entry) => entry.id === id);
		if (!entry) return;
		entry.openings++;
		entry.opening = true;
		entry.allowed = true;
		this.profiles.scheduler.wake();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			entry.openings = Math.max(0, entry.openings - 1);
			entry.opening = entry.openings > 0;
			if (!this.#destroyed) {
				this.candidates(this.#rank);
				this.#trim();
			}
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
			bind: (bindings, target) => {
				if (!owns()) return () => {};
				entry.bindings = bindings;
				entry.target = target;
				return () => {
					if (!owns() || entry.bindings !== bindings) return;
					entry.bindings = undefined;
					if (entry.target === target) entry.target = undefined;
				};
			},
			update: (next) => {
				if (owns()) this.update(entry, next);
			},
			release: () => {
				if (!owns()) return;
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
		entry.bindings = undefined;
		entry.target = undefined;
		entry.lastUsed = ++this.#clock;
		this.#failed.delete(entry.id);
		const profiler = this.profiles.profiler;
		if (
			entry.workspace.viewer.prepared &&
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
		if (entry.id === 'admin') entry.allowed = false;
		entry.bindings = undefined;
		entry.target = undefined;
		entry.workspace.viewer.ready = false;
		entry.workspace.viewer.visible = false;
		if (this.active === entry) this.active = undefined;
		this.update(entry, entry.id === 'admin' ? {} : entry.confirmedChoices);
		this.#trim();
	}
	candidates(ranked: readonly string[], budget = this.#preparationBudget) {
		if (!sameOrder(this.#rank, ranked)) this.#rank = [...ranked];
		this.#preparationBudget = budget;
		const recent = recentOpenings().find((opening) =>
			this.entries.some((entry) => entry.id === opening.id)
		)?.id;
		const reserved = this.entries
			.filter(
				(entry) =>
					entry.id !== 'admin' &&
					(entry.active || entry.opening || entry.draftOwned || entry.id === recent)
			)
			.map((entry) => entry.id);
		const ids = ranked
			.filter((id) => !this.#failed.has(id) && (reserved.includes(id) || reserved.length < 4))
			.slice(0, budget);
		if (!sameOrder(this.#candidates, ids)) this.#candidates = [...ids];
		const pending = this.#pending.filter((data) => ids.includes(data.id));
		if (!sameOrder(this.#pending, pending)) this.#pending = pending;
		for (const id of this.#failed)
			if (id !== 'admin' && !ranked.includes(id)) this.#failed.delete(id);
		for (const entry of this.entries)
			if (
				entry.id !== 'admin' &&
				!entry.active &&
				!entry.opening &&
				!entry.draftOwned &&
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
	prepare(data: ReadyContract) {
		if (this.#destroyed) return;
		const entry = this.entries.find((entry) => entry.id === data.id);
		if (entry) {
			entry.confirmedChoices = data.contract.selectedConcessions;
			if (!entry.active) this.update(entry, entry.confirmedChoices);
			return;
		}
		if (this.#failed.has(data.id) || !this.#candidates.includes(data.id)) return;
		const pending = this.#pending.find((pending) => pending.id === data.id);
		if (pending === data) return;
		if (pending) this.#pending = this.#pending.map((value) => (value === pending ? data : value));
		else this.#pending = [...this.#pending, data];
	}
	failedPreparation(id: string) {
		this.#failed.add(id);
		const entry = this.entries.find((entry) => entry.id === id);
		if (entry && !entry.active && !entry.opening && !entry.draftOwned) this.evict(id);
		this.candidates(this.#rank);
	}
	remove(id: string) {
		this.evict(id);
		this.candidates(this.#rank.filter((candidate) => candidate !== id));
	}

	evict(id: string) {
		if (this.#pending.some((data) => data.id === id))
			this.#pending = this.#pending.filter((data) => data.id !== id);
		const entry = this.entries.find((entry) => entry.id === id);
		if (!entry) return;
		this.entries = this.entries.filter((current) => current !== entry);
		if (this.active === entry) this.active = undefined;
		entry.destroy();
		this.#attachments.delete(entry);
		recordColdStart('document-resource-evicted');
	}
	#removable(saved: readonly DocumentResource[]) {
		const recent = recentOpenings()[0]?.id;
		const rank = (entry: DocumentResource) => {
			const index = this.#rank.indexOf(entry.id);
			return entry.id === recent ? -1 : index < 0 ? Number.MAX_SAFE_INTEGER : index;
		};
		return saved
			.filter((entry) => !entry.active && !entry.opening && !entry.draftOwned)
			.sort((a, b) => rank(b) - rank(a) || a.lastUsed - b.lastUsed);
	}
	#makeRoom(id: string) {
		const saved = this.entries.filter((entry) => entry.id !== 'admin');
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
		const saved = this.entries.filter((entry) => entry.id !== 'admin');
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
	}
}
export function setDocumentResources(resources: DocumentResources) {
	return setContext(RESOURCES, resources);
}
export function getDocumentResources(): DocumentResources | undefined {
	return getContext(RESOURCES);
}
