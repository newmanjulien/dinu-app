<script lang="ts">
	import { setAnnotationRegistry } from '$lib/document/annotation-registry';
	import { restoreDocumentNavigation } from '$lib/document/runtime/navigation.svelte';
	import {
		annotationOccurrence,
		resolveAnnotationAnchor,
		type AnnotationActivation,
		type AnnotationOccurrence
	} from '$lib/document/annotation-anchor';
	import { triggerAnnotationId, type AnnotationMembership } from '$lib/playbook/document-overlay';
	import { tick, untrack, onMount, onDestroy, type Snippet } from 'svelte';
	import type { ContractChange, SourceTarget } from '$lib/playbook/model';
	import { isTextTarget, sameSourceTarget } from '$lib/contract/source-model';
	import { pointPosition } from '$lib/contract/source-index';
	import { unitsInRange, validateTarget } from '$lib/contract/ranges';
	import { EMPTY_PREVIEW_CHANGES, type ConcessionSelection } from '$lib/document/runtime/types';
	import { afterPaint, type Priority } from '$lib/document/runtime/scheduler';
	import { getDocumentResources } from '$lib/document/runtime/resources.svelte';
	import {
		recordColdStart,
		recordDocumentReady,
		recordPageMount
	} from '$lib/document/runtime/render-perf';
	import { prewarmSavedConcessions } from '$lib/document/runtime/prewarm';
	import {
		sourcePointBounds,
		sourceRangeToDomRanges,
		sourceOccurrence,
		sourceTargetBounds
	} from '$lib/document/selection/dom-selection';
	import {
		DocumentHighlightController,
		EMPTY_HIGHLIGHTS,
		type PageHighlights
	} from '$lib/document/highlights/controller';
	import {
		DocumentGestureInteractions,
		type DocumentGestureIntent
	} from '$lib/document/highlights/interactions';
	import { getContractLayoutProfiles } from '$lib/document/runtime/layout-context.svelte';
	import { getContractWorkspace } from '$lib/document/runtime/workspace-context';
	import { activeConflicts } from '$lib/playbook/selection-conflicts';
	import { getDocumentViewportMetrics } from '$lib/document/document-viewport';
	import type { PaginatedPage } from '$lib/document/pagination/types';
	import { PAGE_FORMAT } from '$lib/document/pagination/page-format';
	import {
		LayoutProfiler,
		type LayoutProfileSurface as ProfileSurface
	} from '$lib/document/pagination/profiler';
	import DocumentWorkspaceGeometry from './DocumentWorkspaceGeometry.svelte';
	import DocumentPage from './DocumentPage.svelte';
	import LayoutProfileSurface from './LayoutProfileSurface.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';
	import ContractWorkspaceLayout from './ContractWorkspaceLayout.svelte';
	import '$lib/styles/document.css';
	import ReviewTags from './ReviewTags.svelte';
	import type { ReviewTag, ReviewDecision, ReviewNavigation } from '$lib/contract/approval';
	const annotationRegistry = setAnnotationRegistry();
	let {
		active = true,
		interactive = true,
		retained = false,
		prepare = true,
		priority = () => 'foreground',
		hasPanel = false,
		followScroll = false,
		panelContent,
		footerContent,
		reviewTags = [],
		reviewGutter = 0,
		reviewNavigation,
		onReviewDecision,
		selectedConcessions,
		onRemoveConcession,
		selectedAnnotationId = null,
		selectedRanges = [],
		previewChanges = EMPTY_PREVIEW_CHANGES,
		panelTarget,
		picking = false,
		allowPlaybookNavigation = true,
		playbookNavigationReady = true,
		onSelect,
		onDocumentBackground
	}: {
		active?: boolean;
		interactive?: boolean;
		retained?: boolean;
		prepare?: boolean;
		priority?: Priority;
		hasPanel?: boolean;
		followScroll?: boolean;
		panelContent: Snippet;
		footerContent?: Snippet;
		reviewTags?: readonly ReviewTag[];
		reviewGutter?: number;
		reviewNavigation?: ReviewNavigation;
		onReviewDecision?: (tag: ReviewTag, status: ReviewDecision) => void;
		selectedConcessions: ConcessionSelection;
		onRemoveConcession: (itemId: string) => void;
		selectedAnnotationId?: string | null;
		selectedRanges?: readonly SourceTarget[];
		previewChanges?: readonly ContractChange[];
		/** The selected clause's stable source target; click position never affects panel geometry. */
		panelTarget?: SourceTarget;
		picking?: boolean;
		allowPlaybookNavigation?: boolean;
		playbookNavigationReady?: boolean;
		onSelect: (itemId: string, annotationId: string) => boolean | void;
		onDocumentBackground?: () => void;
	} = $props();
	const { source, renderer, viewer } = getContractWorkspace();
	restoreDocumentNavigation(viewer);
	const interacting = $derived(active && interactive);
	const snapshot = $derived(renderer.snapshot);
	let activationComplete = $state(false);
	let mountedPages = $state.raw<readonly PaginatedPage[]>([]);
	let pageElementsSnapshot = $state.raw<typeof snapshot>();
	const structuralBoundaryAnnotations = $derived.by(() => {
		const byKey = new Map<string, AnnotationMembership[]>();
		const boundaries = pageElementsSnapshot?.source.sourceIndex.structuralBoundaries;
		for (const item of pageElementsSnapshot?.source.items ?? [])
			for (const annotation of item.annotations) {
				if (annotation.range.kind !== 'boundary') continue;
				const boundary = boundaries?.get(annotation.range.afterBlockKey);
				if (!boundary) continue;
				const annotations = byKey.get(boundary.afterBlockKey) ?? [];
				if (!byKey.has(boundary.afterBlockKey)) byKey.set(boundary.afterBlockKey, annotations);
				annotations.push({
					...annotation,
					applied:
						annotation.kind === 'concession-effect' &&
						pageElementsSnapshot?.concessions[item.itemId] === annotation.concessionId
				});
			}
		return byKey;
	});
	let mountedGeneration = $state(0);
	$effect(() => {
		if (!active) activationComplete = false;
		else if (viewer.prepared && viewer.visible) activationComplete = true;
	});
	let highlights = $state<DocumentHighlightController>();
	let documentGestures = $state<DocumentGestureInteractions>();
	let highlightRects = $state.raw<PageHighlights>(new Map());
	$effect(() => {
		const stage = viewer.documentStageElement;
		if (!active || !stage || !viewer.visible) return;
		const abort = new AbortController();
		let controller: DocumentHighlightController | undefined;
		let unsubscribe: (() => void) | undefined;
		void afterPaint(abort.signal)
			.then(() => {
				if (abort.signal.aborted) return;
				controller = new DocumentHighlightController(stage);
				highlights = controller;
				unsubscribe = controller.subscribe((rects) => {
					highlightRects = rects;
				});
			})
			.catch(() => {});
		return () => {
			abort.abort();
			unsubscribe?.();
			controller?.destroy();
			highlights = undefined;
			highlightRects = new Map();
			authoringRanges.clear();
		};
	});
	$effect(() => {
		const stage = viewer.documentStageElement,
			controller = highlights;
		if (!active || !stage || !controller) return;
		const interactions = new DocumentGestureInteractions(stage, controller, handleDocumentIntent);
		documentGestures = interactions;
		return () => {
			interactions.destroy();
			documentGestures = undefined;
		};
	});
	let notifiedController: DocumentHighlightController | undefined;
	let notifiedPages: readonly PaginatedPage[] = [];
	$effect(() => {
		const controller = highlights,
			mounted = mountedPages;
		const epoch = pageElementsSnapshot?.layoutEpoch ?? renderer.pending?.layoutEpoch;
		if (!controller || !epoch) return;
		const previous = notifiedController === controller ? notifiedPages : [];
		const changed = mounted.filter((page, i) => page !== previous[i]).map((page) => page.number);
		for (const page of previous.slice(mounted.length)) changed.push(page.number);
		let cancelled = false;
		void tick().then(() => {
			if (cancelled) return;
			notifiedController = controller;
			notifiedPages = mounted;
			controller.contentCommitted(epoch, changed);
		});
		return () => {
			cancelled = true;
		};
	});
	$effect(() => {
		void pageScale;
		highlights?.projectionChanged();
	});
	const authoringRanges = new Map<
		SourceTarget,
		{
			sourceIndex: NonNullable<typeof snapshot>['source']['sourceIndex'];
			ranges: Range[];
			pages: readonly NonNullable<typeof snapshot>['pages'][number][];
		}
	>();
	$effect(() => {
		const root = viewer.documentStageElement,
			commit = pageElementsSnapshot,
			controller = highlights;
		if (!root || !commit || !controller || !viewer.visible) return;
		const selected = new Set(selectedRanges);
		for (const range of authoringRanges.keys())
			if (!selected.has(range)) authoringRanges.delete(range);
		const boundarySelections: { key: string; startRatio: number; endRatio: number }[] = [];
		const ranges = selectedRanges.flatMap((target) => {
			const index = commit.source.sourceIndex;
			if (!isTextTarget(target)) {
				if (index.structuralBoundaries.has(target.afterBlockKey))
					boundarySelections.push({ key: target.afterBlockKey, startRatio: 0, endRatio: 0 });
				return [];
			}
			const sourceRange = target.range;
			let start: number, end: number;
			try {
				start = pointPosition(index, sourceRange.start);
				end = pointPosition(index, sourceRange.end);
			} catch {
				authoringRanges.delete(target);
				return [];
			}
			const keys = new Set(
				(start < end ? unitsInRange(index, sourceRange) : []).map((unit) => unit.blockKey)
			);
			const pages = commit.pages.filter((page) =>
				page.placements.some(({ fragment }) => keys.has(fragment.blockKey))
			);
			let cached = authoringRanges.get(target);
			if (
				!cached ||
				cached.sourceIndex !== index ||
				cached.ranges.some(
					(range) => !root.contains(range.startContainer) || !root.contains(range.endContainer)
				) ||
				cached.pages.length !== pages.length ||
				cached.pages.some((page, i) => page !== pages[i])
			) {
				cached = {
					sourceIndex: index,
					ranges: sourceRangeToDomRanges(root, sourceRange, index),
					pages
				};
				authoringRanges.set(target, cached);
			}
			return cached.ranges;
		});
		controller.setGroup('authoring', 'authoring-selection', ranges);
		controller.setStructuralBoundaryGroup(
			'authoring-structural-boundaries',
			'authoring-selection',
			boundarySelections
		);
	});
	$effect(() => {
		const stage = viewer.documentStageElement;
		if (!active || !stage) return;
		let focusVersion = 0;
		let commitVersion = 0;
		let cancelled = false;
		const intent = () => focusVersion++;
		const listeners = new AbortController();
		for (const event of ['focusin', 'pointerdown', 'keydown'])
			document.addEventListener(event, intent, { capture: true, signal: listeners.signal });
		const unsubscribe = renderer.beforeCommit(() => {
			const generation = ++commitVersion;
			const owner = document.activeElement;
			if (!(owner instanceof HTMLElement) || !stage.contains(owner) || owner.tabIndex < 0) return;
			const annotationId = owner.dataset.annotationId;
			if (!annotationId) return;
			const occurrence = annotationOccurrence(annotationId, { owner });
			const version = focusVersion;
			void tick().then(() => {
				if (
					cancelled ||
					generation !== commitVersion ||
					!active ||
					!navigationCapable ||
					viewer.documentStageElement !== stage ||
					!stage.isConnected ||
					version !== focusVersion ||
					(document.activeElement && document.activeElement !== document.body)
				)
					return;
				const index = snapshot?.source.sourceIndex;
				const anchor = index
					? resolveAnnotationAnchor(annotationRegistry, index, annotationId, occurrence)
					: undefined;
				(anchor?.owner ?? stage).focus({ preventScroll: true });
			});
		});
		return () => {
			cancelled = true;
			listeners.abort();
			unsubscribe();
		};
	});
	$effect(() => {
		const stage = viewer.documentStageElement;
		if (!active || !stage) return;
		let scrollVersion = 0;
		const onScroll = () => scrollVersion++;
		window.addEventListener('scroll', onScroll, { passive: true });
		const unsubscribe = renderer.beforeCommit(() => {
			const viewportTop = getDocumentViewportMetrics().top;
			let token: HTMLElement | undefined;
			// Search only visible pages; the page margin may contain no source-bearing text.
			for (const page of stage.querySelectorAll<HTMLElement>('[data-page-number]')) {
				const bounds = page.getBoundingClientRect();
				if (bounds.bottom <= viewportTop) continue;
				if (bounds.top >= window.innerHeight) break;
				for (const span of page.querySelectorAll<HTMLElement>(
					'[data-source-start-key]:not([data-generated])'
				)) {
					if (span.dataset.revision && span.dataset.revision !== 'removed') continue;
					const bounds = span.getBoundingClientRect();
					if (bounds.height && bounds.top >= viewportTop && bounds.top < window.innerHeight) {
						token = span;
						break;
					}
				}
				if (token) break;
			}
			const point = token?.dataset.sourceStartKey
				? {
						sourceKey: token.dataset.sourceStartKey,
						offset: Number(token.dataset.sourceStartOffset ?? 0)
					}
				: undefined;
			if (!point || !token || !stage.contains(token)) return;
			const occurrence = sourceOccurrence(token);
			const top = sourcePointBounds(stage, point, true, occurrence)?.top;
			const scrollY = window.scrollY;
			const capturedScrollVersion = scrollVersion;
			void tick().then(() => {
				if (
					!active ||
					!stage.isConnected ||
					window.scrollY !== scrollY ||
					scrollVersion !== capturedScrollVersion ||
					top === undefined
				)
					return;
				const after = sourcePointBounds(stage, point, true, occurrence)?.top;
				if (after !== undefined && Math.abs(after - top) > 0.5)
					window.scrollBy({ top: after - top, behavior: 'instant' });
			});
		});
		return () => {
			unsubscribe();
			window.removeEventListener('scroll', onScroll);
		};
	});
	const requestedModel = $derived.by(() => {
		try {
			return {
				conflicts: source.renderSource
					? activeConflicts(
							source.renderSource.sourceIndex,
							source.renderSource.items,
							selectedConcessions
						)
					: [],
				error: null
			};
		} catch (cause) {
			return {
				conflicts: [],
				error: { message: 'We couldn’t validate the requested contract.', cause }
			};
		}
	});
	const hasActiveConflicts = $derived(requestedModel.conflicts.length > 0);
	const sharedProfiles = getContractLayoutProfiles();
	const resources = getDocumentResources();
	let surface = $state.raw<ProfileSurface>();
	const profiler = $derived(
		sharedProfiles ? sharedProfiles.profiler : surface ? new LayoutProfiler(surface) : undefined
	);
	$effect(() => {
		const local = sharedProfiles ? undefined : profiler;
		return () => local?.scheduler.destroy();
	});
	$effect(() => {
		viewer.preparationBlocked = Boolean(requestedModel.error || hasActiveConflicts);
	});
	const current = $derived(
		Boolean(
			profiler &&
			source.renderSource &&
			!requestedModel.error &&
			renderer.isCurrent({
				source: source.renderSource,
				concessions: selectedConcessions,
				profiler,
				previewChanges
			}) &&
			!renderer.pending &&
			!renderer.error &&
			!hasActiveConflicts
		)
	);
	const partialEligible = $derived(
		Boolean(
			prepare &&
			!source.issue &&
			!requestedModel.error &&
			!hasActiveConflicts &&
			profiler &&
			source.renderSource &&
			renderer.pending?.progressive &&
			renderer.isPreparingCurrent({
				source: source.renderSource,
				concessions: selectedConcessions,
				previewChanges,
				profiler
			})
		)
	);
	const pages = $derived(
		activationComplete
			? (snapshot?.pages ?? [])
			: partialEligible
				? renderer.pending!.pages
				: current
					? snapshot!.pages
					: []
	);
	const targetGeneration = $derived(
		activationComplete || current
			? (snapshot?.id ?? 0)
			: partialEligible
				? renderer.pending!.generation
				: 0
	);
	const incomplete = $derived(
		!activationComplete &&
			(!pageElementsSnapshot || pageElementsSnapshot.id !== targetGeneration || !current)
	);
	const navigationCapable = $derived(active && allowPlaybookNavigation && !picking);
	const canOpenPlaybookItems = $derived(
		interacting && viewer.prepared && current && navigationCapable && playbookNavigationReady
	);
	const documentBackgroundDismissalEnabled = $derived(hasPanel && Boolean(onDocumentBackground));
	const protectDocumentStage = $derived(hasPanel);
	$effect(() => {
		documentGestures?.setPolicy({
			clauseActivation: canOpenPlaybookItems,
			backgroundActivation: documentBackgroundDismissalEnabled
		});
	});
	let layoutElement = $state<HTMLDivElement>();
	let displayWidth = $state<number>(PAGE_FORMAT.width);
	let panelPosition = $state.raw<{ target: SourceTarget; top: number }>();
	const panelTop = $derived(panelPosition?.top);
	const panelResolved = $derived(Boolean(panelPosition));
	let panelPositionChange = $state(0);
	let selectedOccurrence = $state.raw<AnnotationOccurrence | null>(null);
	let pageViewport = $state<HTMLDivElement>();
	const loading = $derived(
		!renderer.error && (!pages.length || (active && !viewer.visible && !viewer.preparationBlocked))
	);
	const pageScale = $derived(displayWidth / PAGE_FORMAT.width);
	const displayHeight = $derived(
		(mountedPages.length * PAGE_FORMAT.height +
			Math.max(0, mountedPages.length - 1) * PAGE_FORMAT.gap +
			(incomplete ? 64 : 0)) *
			pageScale
	);
	function annotationAnchor(
		annotationId = selectedAnnotationId,
		occurrence = selectedOccurrence,
		target = panelTarget
	) {
		const root = viewer.documentStageElement,
			index = snapshot?.source.sourceIndex;
		if (!root || !index) return;
		// If selection identity is temporarily absent, recover its matching trigger from the target.
		const fallbackTrigger = target
			? source.geometry
					?.triggersIntersecting(target)
					.find((trigger) => sameSourceTarget(trigger.range, target))
			: undefined;
		const fallback = fallbackTrigger
			? [...(source.geometry?.triggerIds.get(fallbackTrigger.id) ?? [])][0]
			: undefined;
		const id =
			annotationId ?? (fallback ? triggerAnnotationId(fallback.itemId, fallback.trigger.id) : null);
		const point = target && isTextTarget(target) ? target.range.start : undefined;
		return resolveAnnotationAnchor(
			annotationRegistry,
			index,
			id,
			occurrence?.annotationId === id ? occurrence : null,
			point
		);
	}
	/** Retain source coordinates so focus can return after the editor and preview disappear. */
	function captureAnnotationFocus() {
		const id = selectedAnnotationId,
			occurrence = selectedOccurrence,
			target = panelTarget;
		return () => {
			if (!active) return;
			const anchor = annotationAnchor(id, occurrence, target);
			(anchor?.owner ?? viewer.documentStageElement)?.focus({ preventScroll: true });
		};
	}
	function restoreAnnotationFocus() {
		captureAnnotationFocus()();
	}
	function panelPositionRequest() {
		const target = panelTarget,
			stage = viewer.documentStageElement,
			index = snapshot?.source.sourceIndex,
			layout = layoutElement;
		return active && hasPanel && target && stage && index && layout
			? { target, stage, index, layout }
			: undefined;
	}
	function panelPositionRequestIsCurrent(
		request: NonNullable<ReturnType<typeof panelPositionRequest>>
	) {
		return (
			active &&
			hasPanel &&
			Boolean(panelTarget && sameSourceTarget(panelTarget, request.target)) &&
			viewer.documentStageElement === request.stage &&
			snapshot?.source.sourceIndex === request.index &&
			layoutElement === request.layout
		);
	}
	async function positionPanel(request = panelPositionRequest()) {
		if (!request) return;
		try {
			validateTarget(request.index, request.target);
		} catch {
			if (panelPositionRequestIsCurrent(request)) panelPosition = undefined;
			return;
		}
		await tick();
		if (!panelPositionRequestIsCurrent(request)) return;
		const bounds = sourceTargetBounds(request.stage, request.target, request.index);
		// A prior resolved position remains during a clause switch until the new page DOM commits.
		// An initial panel has no fallback position, so it never renders at an arbitrary page top.
		if (!bounds) return;
		const top = Math.max(0, bounds.top - request.layout.getBoundingClientRect().top);
		if (
			!panelPosition ||
			!sameSourceTarget(panelPosition.target, request.target) ||
			Math.abs(panelPosition.top - top) > 0.5
		)
			panelPosition = { target: request.target, top };
	}
	function selectAnnotation(
		itemId: string,
		annotationId: string,
		activation: AnnotationActivation
	) {
		if (!canOpenPlaybookItems) return;
		if (onSelect(itemId, annotationId) === false) return;
		selectedOccurrence = annotationOccurrence(annotationId, activation);
		if (panelPosition) panelPositionChange += 1;
	}
	function handleDocumentIntent(intent: DocumentGestureIntent) {
		if (intent.kind === 'activate-background') {
			if (hasPanel) onDocumentBackground?.();
			return;
		}
		selectAnnotation(intent.itemId, intent.annotationId, intent.activation);
	}
	$effect(() => {
		if (!active || !hasPanel || !panelTarget) panelPosition = undefined;
	});
	$effect(() => {
		const selected = selectedAnnotationId,
			open = hasPanel;
		untrack(() => {
			if (!open || selectedOccurrence?.annotationId !== selected) selectedOccurrence = null;
		});
	});
	$effect(() => {
		const request = panelPositionRequest();
		// Page mounting and the final page-elements commit can both make a previously unresolved
		// semantic target measurable. They must independently retry the anchor lookup.
		void mountedPages;
		void pageElementsSnapshot;
		void pageScale;
		if (request) void positionPanel(request);
	});
	async function keepPanelVisible() {
		const panel = layoutElement?.querySelector<HTMLElement>('[data-workspace-panel]');
		if (!active || !panel || !hasPanel) return;
		await positionPanel();
		await tick();
		if (
			!active ||
			!hasPanel ||
			followScroll ||
			layoutElement?.querySelector('[data-workspace-panel]') !== panel
		)
			return;
		const rail = panel.parentElement;
		if (!rail || getComputedStyle(rail).position === 'fixed') return;
		const viewport = getDocumentViewportMetrics();
		const top = panel.getBoundingClientRect().top;
		if (top < viewport.top || top >= window.innerHeight - viewport.gap)
			window.scrollBy({ top: top - viewport.top, behavior: 'instant' });
	}
	let wasFollowingScroll = false;
	$effect(() => {
		const following = followScroll;
		if (active && wasFollowingScroll && !following) untrack(() => void keepPanelVisible());
		wasFollowingScroll = following;
	});
	function retryRender() {
		if (!prepare) return;
		if (requestedModel.error) {
			renderer.fail(requestedModel.error);
			return;
		}
		if (profiler && source.renderSource && !hasActiveConflicts)
			renderer.request({
				source: source.renderSource,
				concessions: selectedConcessions,
				previewChanges,
				priority,
				progressive: !activationComplete,
				profiler
			});
	}
	$effect(() => {
		const enabled = prepare;
		const layoutProfiler = profiler,
			model = source.renderSource,
			selection = selectedConcessions,
			preview = previewChanges,
			blocked = hasActiveConflicts,
			error = requestedModel.error;
		untrack(() => {
			if (!enabled) {
				renderer.cancelPending();
				return;
			}
			if (error) {
				renderer.fail(error);
				return;
			}
			if (!layoutProfiler || !model || blocked) {
				renderer.cancelPending();
				return;
			}
			if (
				renderer.isCurrent({
					source: model,
					concessions: selection,
					profiler: layoutProfiler,
					previewChanges: preview
				})
			) {
				renderer.cancelPending();
				return;
			}
			renderer.request({
				source: model,
				concessions: selection,
				previewChanges: preview,
				priority,
				progressive: !activationComplete,
				profiler: layoutProfiler
			});
		});
	});
	onMount(() => {
		if (interacting) recordColdStart('viewer-mounted');
	});
	$effect(() => {
		viewer.retry = retryRender;
		return () => {
			viewer.retry = undefined;
		};
	});
	$effect(() => {
		if (!active) return;
		viewer.restoreAnnotationFocus = restoreAnnotationFocus;
		viewer.captureAnnotationFocus = captureAnnotationFocus;
		return () => {
			viewer.restoreAnnotationFocus = undefined;
			viewer.captureAnnotationFocus = undefined;
		};
	});

	$effect(() => {
		const layoutProfiler = profiler,
			commit = snapshot;
		if (
			!interacting ||
			!viewer.prepared ||
			!current ||
			previewChanges.length ||
			!commit ||
			!layoutProfiler
		)
			return;
		const artifacts = renderer.artifacts;
		if (!artifacts || artifacts.source !== commit.source) return;
		const focusedItemId = hasPanel
			? commit.source.items.find((item) =>
					item.annotations.some((annotation) => annotation.id === selectedAnnotationId)
				)?.itemId
			: undefined;
		return untrack(() =>
			prewarmSavedConcessions(
				commit,
				layoutProfiler,
				artifacts,
				focusedItemId,
				renderer.paginationHistory
			)
		);
	});
	$effect(() => {
		const available = pages,
			generation = targetGeneration,
			epoch = current || activationComplete ? snapshot?.layoutEpoch : renderer.pending?.layoutEpoch,
			commit = current || activationComplete ? snapshot : null,
			enabled = prepare,
			layoutProfiler = profiler,
			warm = activationComplete;
		// Paused retained viewers keep their pages without scheduling more work.
		if (!enabled && retained) return;
		if (!enabled || !layoutProfiler || !generation) {
			if (!warm)
				untrack(() => {
					mountedPages = [];
					mountedGeneration = 0;
					pageElementsSnapshot = null;
				});
			return;
		}
		const abort = new AbortController();
		untrack(async () => {
			if (warm) {
				if (
					mountedGeneration !== generation ||
					mountedPages.length !== available.length ||
					mountedPages.some((page, i) => page !== available[i])
				) {
					const startedAt = performance.now();
					mountedPages = available;
					mountedGeneration = generation;
					await tick();
					if (!abort.signal.aborted)
						recordPageMount(generation, startedAt, mountedPages.length, true);
				}
			} else {
				if (
					mountedGeneration !== generation ||
					mountedPages.some((page, i) => page !== available[i])
				) {
					mountedPages = [];
					pageElementsSnapshot = null;
					mountedGeneration = generation;
				}
				while (mountedPages.length < available.length) {
					await layoutProfiler.scheduler.run(
						priority,
						async () => {
							if (abort.signal.aborted) return;
							const startedAt = performance.now();
							const pageCount = mountedPages.length + 1;
							mountedPages = available.slice(0, pageCount);
							await tick();
							if (!abort.signal.aborted) recordPageMount(generation, startedAt, pageCount);
						},
						abort.signal,
						() => active || !retained,
						'append'
					);
					if (mountedPages.length === 1 && epoch) {
						await afterPaint(abort.signal);
						renderer.acknowledgeFirstPagePaint(generation, epoch);
					}
				}
			}
			await tick();
			if (!abort.signal.aborted && commit && mountedPages.length === commit.pages.length) {
				pageElementsSnapshot = commit;
				recordColdStart(active ? 'active-page-elements-ready' : 'background-page-elements-ready');
			}
		}).catch(() => {});
		return () => abort.abort();
	});
	$effect(() => {
		viewer.visible =
			active &&
			Boolean(mountedPages.length) &&
			(activationComplete ||
				(mountedGeneration === targetGeneration && (partialEligible || current)));
		viewer.displayedSnapshot =
			viewer.visible &&
			pageElementsSnapshot &&
			(pageElementsSnapshot.id === targetGeneration || activationComplete)
				? pageElementsSnapshot
				: null;
	});
	$effect(() => {
		if (!viewer.visible) return;
		const abort = new AbortController();
		void afterPaint(abort.signal)
			.then(() => recordColdStart('first-exact-display'))
			.catch(() => {});
		return () => abort.abort();
	});
	$effect(() => {
		if (active && viewer.visible && snapshot && profiler)
			untrack(() => renderer.protectGeometry(profiler!));
	});
	let lastReadySnapshot: typeof snapshot;
	let visibleGeneration = 0;
	$effect(() => {
		const prepared = current && pageElementsSnapshot === snapshot;
		viewer.prepared = prepared;
		viewer.ready = interacting && prepared;
		if (interacting && prepared) {
			if (lastReadySnapshot === snapshot) recordColdStart('prepared-page-elements-reused');
			lastReadySnapshot = snapshot;
			recordColdStart('interaction-ready');
			const navigationStartedAt = recordDocumentReady();
			const generation = ++visibleGeneration;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const frame = requestAnimationFrame(() => {
				timer = setTimeout(() => {
					if (interacting && generation === visibleGeneration)
						recordColdStart('first-visible-paint-opportunity', navigationStartedAt);
				}, 0);
			});
			return () => {
				cancelAnimationFrame(frame);
				clearTimeout(timer);
			};
		}
		if (prepared) lastReadySnapshot = snapshot;
	});
	onDestroy(() => {
		viewer.ready = false;
		viewer.visible = false;
		viewer.displayedSnapshot = null;
		viewer.documentStageElement = undefined;
		viewer.retry = undefined;
		viewer.restoreAnnotationFocus = undefined;
		viewer.captureAnnotationFocus = undefined;
		annotationRegistry.clear();
		if (!retained) renderer.destroy();
	});
</script>

{#if hasActiveConflicts}
	<div
		role="alert"
		class="mx-auto max-w-xl rounded border-hairline border-edge bg-surface p-3 shadow-card"
	>
		These applied concessions conflict with current contract changes. Remove an alternative to
		continue.
		{#each requestedModel.conflicts as conflict}
			{@const item = source.items?.find((item) => item._id === conflict.itemId)}
			{@const concession = item?.concessions.find(
				(concession) => concession.id === conflict.concession.id
			)}
			<button
				class="ml-2 underline"
				onclick={interacting ? () => onRemoveConcession(conflict.itemId) : undefined}
				>Remove “{concession?.description ?? conflict.concession.id}”{item?.instructions?.summary
					? ` — ${item.instructions.summary}`
					: ''}</button
			>{/each}
	</div>
{/if}
{#if !sharedProfiles}<LayoutProfileSurface bind:surface />{/if}
<DocumentWorkspaceGeometry
	{reviewGutter}
	{hasPanel}
	onPageResize={(width) => (displayWidth = width)}
>
	<div
		class="viewer-root w-full"
		data-document-commit={targetGeneration}
		data-page-count={mountedPages.length}
		style:--contract-page-width={`${PAGE_FORMAT.width}px`}
		style:--contract-page-height={`${PAGE_FORMAT.height}px`}
		style:--contract-page-horizontal-padding={`${PAGE_FORMAT.horizontalPadding}px`}
		style:--contract-page-top-padding={`${PAGE_FORMAT.topPadding}px`}
		style:--contract-first-page-top-padding={`${PAGE_FORMAT.firstTopPadding}px`}
		style:--contract-page-bottom-padding={`${PAGE_FORMAT.bottomPadding}px`}
		style:--contract-content-width={`${PAGE_FORMAT.contentWidth}px`}
		style:--contract-page-gap={`${PAGE_FORMAT.gap}px`}
	>
		{#snippet documentContent()}
			{#if pages.length}
				<div
					class="page-viewport relative isolate shrink-0 focus:outline-none"
					bind:this={pageViewport}
					style:width="100%"
					style:height={`${displayHeight}px`}
				>
					<ReviewTags
						host={pageViewport}
						tags={reviewTags}
						navigation={reviewNavigation}
						onDecision={onReviewDecision}
						ready={interacting && viewer.ready}
						index={pageElementsSnapshot?.source.sourceIndex ?? snapshot?.source.sourceIndex}
						pages={mountedPages}
						scale={pageScale}
					/>
					<div
						class="page-stack absolute top-0 left-0 z-1 flex w-(--contract-page-width) origin-top-left flex-col gap-(--contract-page-gap)"
						style:transform={`scale(${pageScale})`}
					>
						{#each mountedPages as page (page.number)}
							<DocumentPage
								{page}
								interactive={active && (interactive || allowPlaybookNavigation)}
								highlights={highlightRects.get(page.number) ?? EMPTY_HIGHLIGHTS}
								{selectedAnnotationId}
								{navigationCapable}
								{canOpenPlaybookItems}
								{structuralBoundaryAnnotations}
								onAnnotationSelect={selectAnnotation}
							/>
						{/each}
						{#if incomplete}
							<div
								class="px-6 py-3 text-center text-sm text-ink-secondary"
								role={renderer.error ? 'alert' : 'status'}
							>
								{#if renderer.error}
									This document is incomplete. We couldn’t prepare the remaining pages.
									<button
										type="button"
										class="ml-2 underline"
										onclick={interacting ? retryRender : undefined}>Retry</button
									>
								{:else}Preparing remaining pages…{/if}
							</div>
						{/if}
					</div>
				</div>
			{:else if renderer.error}
				<LoadingState layout="workspace" class="gap-1.5 text-ink-secondary">
					<strong role="alert" class="font-medium">We couldn’t display this contract.</strong>
					<button type="button" class="underline" onclick={interacting ? retryRender : undefined}
						>Retry</button
					>
				</LoadingState>
			{/if}
		{/snippet}
		<ContractWorkspaceLayout
			{hasPanel}
			{protectDocumentStage}
			{loading}
			interactive={!loading && active && (interactive || allowPlaybookNavigation)}
			{followScroll}
			documentHeight={loading ? PAGE_FORMAT.height * pageScale : displayHeight}
			{panelTop}
			{panelResolved}
			{panelPositionChange}
			bind:layoutElement
			bind:documentStageElement={viewer.documentStageElement}
			{documentContent}
			{panelContent}
			{footerContent}
		/>
	</div>
</DocumentWorkspaceGeometry>
