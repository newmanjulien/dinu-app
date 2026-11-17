<script lang="ts">
	import DiscussionLayer from '$lib/discussions/DiscussionLayer.svelte';
	import type { DiscussionSession } from '$lib/discussions/session.svelte';
	import type { DeepReadonly } from '$lib/immutable';

	import { readableAnnotations } from '$lib/document/readable-annotations';
	import { getAnnotationLabel } from '$lib/document/annotation-label';
	import type {
		AnnotationAdmission,
		AuthoringSelectionRequest
	} from '$lib/playbook/authoring-selection';

	import { setAnnotationRegistry } from '$lib/document/annotation-registry';
	import { DocumentAnnotationProjection } from '$lib/document/annotation-projection';
	import { bindDocumentNavigation } from '$lib/document/runtime/navigation.svelte';
	import {
		getDocumentSection,
		type DocumentSectionHandle
	} from '$lib/document/runtime/section.svelte';
	import {
		matchesMountedSnapshot,
		type MountedDocumentRevision
	} from '$lib/document/runtime/viewer.svelte';
	import {
		annotationOccurrence,
		resolveAnnotationAnchor,
		type AnnotationActivation,
		type AnnotationOccurrence
	} from '$lib/document/annotation-anchor';
	import type { AnnotationMembership } from '$lib/playbook/document-overlay';
	import { tick, untrack, onMount, onDestroy, type Snippet } from 'svelte';
	import type { ContractChange, SourceTarget } from '$lib/playbook/model';
	import { isTextTarget, sameSourceTarget } from '$lib/document/source-model';
	import { pointPosition, type SourceIndex } from '$lib/document/source-index';
	import { panelTargetBounds } from '$lib/document/panel-anchor';
	import {
		breakGroupKeys,
		boundaryTargetBreakGroups,
		legacyTextNavigationGroups
	} from '$lib/document/selection/selection-model';
	import { DocumentSelectionController } from '$lib/document/selection/document-selection';
	import { targetPosition, unitsInRange, validateTarget } from '$lib/document/ranges';
	import { PlaybookValidationError } from '$lib/playbook/validation-error';
	import {
		EMPTY_PREVIEW_CHANGES,
		type AnnotationProjectionDocument,
		type ConcessionSelection,
		type RenderFailure
	} from '$lib/document/runtime/types';
	import { afterPaint, type Priority } from '$lib/document/runtime/scheduler';
	import {
		getDocumentResources,
		type ViewerBindings
	} from '$lib/document/runtime/resources.svelte';
	import {
		createDocumentLoadingViewerId,
		createPanelOpenSample,
		documentLoadingPerfEnabled,
		recordColdStart,
		recordDocumentLoadingMilestone,
		recordDocumentReady,
		recordPageMount,
		recordPanelReadiness,
		type PanelOpenPerfSample
	} from '$lib/document/runtime/render-perf';
	import { prewarmSavedConcessions } from '$lib/document/runtime/prewarm';
	import {
		sourcePointBounds,
		sourceRangeToDomRanges,
		sourceOccurrence
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
	import { getDocumentLayoutProfiles } from '$lib/document/runtime/layout-context.svelte';
	import { getDocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import { activeConflicts } from '$lib/playbook/selection-conflicts';
	import {
		getDocumentViewportMetrics,
		revealInDocumentViewport
	} from '$lib/document/document-viewport';
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
	import DocumentWorkspaceLayout from './DocumentWorkspaceLayout.svelte';
	import '$lib/styles/document.css';
	import ReviewTags from './ReviewTags.svelte';
	import type { ReviewTag, ReviewDecision, ReviewNavigation } from '$lib/contract/approval';
	const annotationRegistry = setAnnotationRegistry();
	let {
		reserveReviewGutter = false,
		active = true,
		foreground = true,
		section = getDocumentSection(),
		navigationIdentity,
		placementReady,
		interactive = true,
		annotationsVisible = true,
		retained = false,
		prepare = true,
		itemPreload,
		priority = () => 'foreground',
		hasPanel = false,
		followScroll = false,
		panelContent,
		footerContent,
		documentActions,
		reviewTags = [],
		reviewNavigation,
		onReviewDecision,
		selectedConcessions,
		onRemoveConcession,
		selectedAnnotationId = null,
		selectionRequest = null,
		selectedRanges = [],
		previewChanges = EMPTY_PREVIEW_CHANGES,
		panelTarget,
		picking = false,
		allowPlaybookNavigation = true,
		sourceSelectionEnabled = false,
		playbookNavigationReady = true,
		onSelect,
		onItemIntent,
		onDocumentBackground,
		onPresentation,
		onRetry,
		onFailure,
		failure,
		annotationItems,
		discussions
	}: {
		reserveReviewGutter?: boolean;
		discussions?: DiscussionSession;
		annotationItems?: readonly import('$lib/playbook/document-overlay').DocumentAnnotationItem[];
		active?: boolean;
		foreground?: boolean;
		section?: DocumentSectionHandle;
		navigationIdentity?: object;
		placementReady?: boolean;
		interactive?: boolean;
		annotationsVisible?: boolean;
		retained?: boolean;
		prepare?: boolean;
		itemPreload?: ViewerBindings['itemPreload'];
		priority?: Priority;
		hasPanel?: boolean;
		followScroll?: boolean;
		panelContent: Snippet;
		footerContent?: Snippet;
		documentActions?: Snippet<
			[HTMLElement, HTMLElement, DocumentHighlightController | undefined, unknown, unknown, boolean]
		>;
		reviewTags?: readonly ReviewTag[];
		reviewNavigation?: ReviewNavigation;
		onReviewDecision?: (tag: ReviewTag, status: ReviewDecision) => void;
		selectedConcessions: ConcessionSelection;
		onRemoveConcession: (itemId: string) => void;
		selectedAnnotationId?: string | null;
		selectionRequest?: AuthoringSelectionRequest | null;
		selectedRanges?: readonly SourceTarget[];
		previewChanges?: DeepReadonly<ContractChange[]>;
		/** The selected clause's stable source target; click position never affects panel geometry. */
		panelTarget?: SourceTarget;
		picking?: boolean;
		allowPlaybookNavigation?: boolean;
		sourceSelectionEnabled?: boolean;
		playbookNavigationReady?: boolean;
		onItemIntent?: (itemId: string) => void;
		onSelect: (itemId: string, annotationId: string) => AnnotationAdmission | boolean | void;
		onDocumentBackground?: () => void;
		onPresentation?: (
			outcome: import('$lib/auth/workspace-presentation.svelte').PresentationOutcome
		) => void;
		onRetry?: () => void;
		onFailure?: () => void;
		failure?: RenderFailure;
	} = $props();
	const { source, renderer, viewer } = getDocumentWorkspace();
	const loadingViewer = createDocumentLoadingViewerId();
	const physicallyPlaced = $derived(
		placementReady ??
			Boolean(
				viewer.documentStageElement && section?.viewport?.contains(viewer.documentStageElement)
			)
	);
	const presented = $derived(physicallyPlaced && foreground && (section?.active ?? true));
	const localNavigationIdentity = {};
	bindDocumentNavigation(
		viewer,
		() => navigationIdentity ?? localNavigationIdentity,
		() => section,
		() => active && foreground,
		() => physicallyPlaced
	);
	const interacting = $derived(active && interactive);
	const snapshot = $derived(renderer.snapshot);
	const annotationLabel = getAnnotationLabel();
	const displayedAnnotations = $derived(
		!annotationsVisible
			? []
			: annotationItems
				? readableAnnotations(annotationItems, snapshot)
				: source.annotations
	);
	const effectiveSummary = $derived(renderer.view === 'effective' && Boolean(annotationItems));
	const positioningTarget = $derived.by(() => {
		if (!effectiveSummary) return panelTarget;
		const item = displayedAnnotations.find((item) =>
			item.annotations.some((annotation) => annotation.id === selectedAnnotationId)
		);
		return (
			item?.annotations.find((annotation) => annotation.kind === 'trigger')?.target ??
			item?.annotations.find((annotation) => annotation.id === selectedAnnotationId)?.target
		);
	});
	$effect(() => {
		if (effectiveSummary && snapshot && hasPanel && !positioningTarget)
			untrack(() => onDocumentBackground?.());
	});
	let activationComplete = $state(false);
	let mountedPages = $state.raw<readonly PaginatedPage[]>([]);
	let pageElementsSnapshot = $state.raw<typeof snapshot>();
	let nextMountedDomRevision = 0;
	let earlyHighlightDocument = $state.raw<AnnotationProjectionDocument | null>(null);
	let completePagesGeneration = 0;
	const structuralBoundaryAnnotations = $derived.by(() => {
		const byKey = new Map<string, AnnotationMembership[]>();
		const index = pageElementsSnapshot?.source.sourceIndex;
		if (!index) return byKey;
		for (const item of displayedAnnotations)
			for (const annotation of item.annotations) {
				let keys: string[];
				try {
					const context = pageElementsSnapshot!.selectionDocument;
					keys = (
						annotation.target.kind === 'boundary'
							? boundaryTargetBreakGroups(context, annotation.target)
							: renderer.view === 'effective'
								? []
								: legacyTextNavigationGroups(context, annotation.target)
					).flatMap(breakGroupKeys);
				} catch {
					continue;
				}
				for (const key of keys) {
					const annotations = byKey.get(key) ?? [];
					if (!byKey.has(key)) byKey.set(key, annotations);
					annotations.push({
						...annotation,
						applied:
							annotation.kind === 'concession-effect' &&
							pageElementsSnapshot?.concessions[item.itemId] === annotation.concessionId
					});
				}
			}
		return byKey;
	});
	$effect(() => {
		const controller = highlights;
		if (!controller) return;
		const selections = [...structuralBoundaryAnnotations].flatMap(([key, memberships]) => {
			const owner = memberships
				.filter(
					(member) =>
						member.target.kind === 'boundary' && (member.kind === 'trigger' || member.applied)
				)
				.sort(
					(a, b) =>
						Number(a.kind !== 'trigger') - Number(b.kind !== 'trigger') || a.id.localeCompare(b.id)
				)[0];
			return owner ? [{ key, kind: owner.highlightKind }] : [];
		});
		for (const kind of ['rep-attachment', 'buyer-attachment'] as const)
			controller.setStructuralBoundaryGroup(
				`saved-structural-${kind}`,
				kind,
				selections.filter((selection) => selection.kind === kind).map(({ key }) => ({ key }))
			);
	});
	let mountedGeneration = $state(0);
	let flushedGeneration = $state(0);
	$effect(() => {
		if (!active) activationComplete = false;
		else if (viewer.layoutPrepared && viewer.pagesVisible) activationComplete = true;
	});
	let highlights = $state<DocumentHighlightController>();
	let documentGestures = $state<DocumentGestureInteractions>();
	let discussionLayer = $state<DiscussionLayer>();
	let highlightRects = $state.raw<PageHighlights>(new Map());
	let annotationProjection = $state.raw<DocumentAnnotationProjection>();
	let projectedGeneration = 0;
	let firstHighlightGeneration = 0;
	let actionsEnabledGeneration = 0;
	$effect(() => {
		const stage = viewer.documentStageElement,
			controller = highlights;
		if (!active || !stage || !controller) return;
		const projection = new DocumentAnnotationProjection(
			stage,
			controller,
			annotationRegistry,
			selectAnnotation,
			annotationLabel
		);
		annotationProjection = projection;
		return () => {
			projection.destroy();
			annotationProjection = undefined;
		};
	});
	$effect(() => {
		const projection = annotationProjection,
			commit = highlightDocument,
			revision = viewer.mountedDomRevision;
		if (
			!projection ||
			!commit ||
			!revision ||
			revision.generation !== commit.id ||
			revision.layoutEpoch !== commit.layoutEpoch ||
			commit.pages.some((page, i) => revision.pages[i] !== page)
		)
			return;
		projection.update({
			snapshot: commit,
			items: highlightAnnotations,
			selected: selectedAnnotationId,
			capable: navigationCapable,
			enabled: canOpenPlaybookItems,
			domRevision: revision
		});
		if (projectedGeneration !== commit.id) {
			projectedGeneration = commit.id;
			recordDocumentLoadingMilestone('annotation-projection-ready', {
				viewer: loadingViewer,
				generation: commit.id
			});
		}
	});
	$effect(() => {
		const commit = pageElementsSnapshot,
			projection = annotationProjection,
			ready = canOpenPlaybookItems,
			rects = highlightRects;
		if (
			!documentLoadingPerfEnabled() ||
			!commit ||
			!projection ||
			!ready ||
			!mountedPages
				.slice(0, 3)
				.some((page) =>
					rects
						.get(page.number)
						?.some((rect) => rect.kind === 'rep-attachment' || rect.kind === 'buyer-attachment')
				) ||
			actionsEnabledGeneration === commit.id
		)
			return;
		let cancelled = false;
		void tick().then(() => {
			if (cancelled || pageElementsSnapshot !== commit || !canOpenPlaybookItems) return;
			const firstPages = new Set(mountedPages.slice(0, 3).map((page) => page.number));
			const actionable = viewer.documentStageElement?.querySelectorAll<HTMLElement>(
				'[data-annotation-projected][role="button"][aria-disabled="false"]'
			);
			if (
				!actionable ||
				![...actionable].some((owner) =>
					firstPages.has(Number(owner.closest<HTMLElement>('.document-page')?.dataset.pageNumber))
				)
			)
				return;
			actionsEnabledGeneration = commit.id;
			recordDocumentLoadingMilestone('highlight-actions-enabled', {
				viewer: loadingViewer,
				generation: commit.id
			});
		});
		return () => {
			cancelled = true;
		};
	});
	$effect(() => {
		const rects = highlightRects,
			commit = highlightDocument,
			mounted = mountedPages;
		if (
			!documentLoadingPerfEnabled() ||
			!active ||
			!viewer.pagesVisible ||
			!commit ||
			commit.id !== targetGeneration ||
			firstHighlightGeneration === commit.id
		)
			return;
		const count = mounted
			.slice(0, 3)
			.reduce(
				(total, page) =>
					total +
					(rects
						.get(page.number)
						?.filter((rect) => rect.kind === 'rep-attachment' || rect.kind === 'buyer-attachment')
						.length ?? 0),
				0
			);
		if (!count) return;
		let cancelled = false;
		void tick().then(() => {
			if (cancelled || highlightDocument !== commit || highlightRects !== rects) return;
			firstHighlightGeneration = commit.id;
			recordDocumentLoadingMilestone('first-highlights-dom-ready', {
				viewer: loadingViewer,
				generation: commit.id,
				pages: Math.min(3, mounted.length),
				highlights: count
			});
		});
		return () => {
			cancelled = true;
		};
	});
	$effect(() => {
		const stage = viewer.documentStageElement;
		if (!active || !annotationsVisible || !stage || !viewer.pagesVisible || !hasHighlightDocument)
			return;
		const abort = new AbortController();
		let controller: DocumentHighlightController | undefined;
		let unsubscribe: (() => void) | undefined;
		void afterPaint(abort.signal)
			.then(() => {
				if (abort.signal.aborted) return;
				controller = new DocumentHighlightController(stage, {
					measurementBatchSize: pageElementsSnapshot?.id === targetGeneration ? Infinity : 1
				});
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
		const controller = highlights;
		if (!controller) return;
		// Completion gives the existing controller more throughput without a large frame of work.
		controller.setSnapshotComplete(pageElementsSnapshot?.id === targetGeneration);
	});
	$effect(() => {
		const stage = viewer.documentStageElement,
			controller = highlights;
		if (!active || !stage || !controller || !pageElementsSnapshot) return;
		const interactions = new DocumentGestureInteractions(
			stage,
			controller,
			handleDocumentIntent,
			(itemId) => onItemIntent?.(itemId)
		);
		documentGestures = interactions;
		return () => {
			interactions.destroy();
			documentGestures = undefined;
		};
	});
	$effect(() => {
		const stage = viewer.documentStageElement,
			commit = pageElementsSnapshot,
			controller = highlights;
		if (
			!active ||
			!sourceSelectionEnabled ||
			renderer.pending ||
			!viewer.interactionEnabled ||
			!current ||
			!stage ||
			!commit ||
			commit !== snapshot ||
			!controller
		)
			return;
		let cancelled = false;
		let selection: DocumentSelectionController | undefined;
		void tick().then(() => {
			if (!cancelled) selection = new DocumentSelectionController(stage, commit, controller);
		});
		return () => {
			cancelled = true;
			selection?.destroy();
		};
	});
	let notifiedController: DocumentHighlightController | undefined;
	let notifiedRevision: MountedDocumentRevision | null = null;
	function notifyMountedContent(
		controller: DocumentHighlightController,
		revision: MountedDocumentRevision
	) {
		const previous = notifiedController === controller ? notifiedRevision : null;
		if (previous === revision) return;
		const changed =
			previous && previous.selectionDocument === revision.selectionDocument
				? revision.pages.filter((page, i) => page !== previous.pages[i]).map((page) => page.number)
				: revision.pages.map((page) => page.number);
		for (const page of previous?.pages.slice(revision.pages.length) ?? [])
			changed.push(page.number);
		notifiedController = controller;
		notifiedRevision = revision;
		controller.contentCommitted(revision.layoutEpoch, changed);
	}
	$effect(() => {
		const controller = highlights,
			revision = viewer.mountedDomRevision;
		if (controller && revision) notifyMountedContent(controller, revision);
	});
	$effect(() => {
		const report = itemPreload,
			controller = highlights,
			annotations = displayedAnnotations,
			commit = pageElementsSnapshot,
			navigation = navigationCapable;
		void mountedPages;
		void annotationProjection;
		if (
			!active ||
			!report ||
			!controller ||
			!commit ||
			commit.source.sourceIndex !== source.compiled?.index
		)
			return;
		let cancelled = false;
		let release: (() => void) | undefined;
		// Both projected text owners and Svelte boundary/grouped controls commit before this tick.
		void tick().then(() => {
			if (
				cancelled ||
				!active ||
				itemPreload !== report ||
				highlights !== controller ||
				displayedAnnotations !== annotations ||
				pageElementsSnapshot !== commit ||
				commit.source.sourceIndex !== source.compiled?.index ||
				navigationCapable !== navigation
			)
				return;
			const occurrences: {
				page: number;
				position: number;
				annotationId: string;
				itemId: string;
			}[] = [];
			for (const item of annotations) {
				if (item.itemId.startsWith('pending:')) continue;
				for (const annotation of item.annotations) {
					let position: number;
					try {
						position = targetPosition(commit.source.sourceIndex, annotation.target);
					} catch (error) {
						if (error instanceof PlaybookValidationError) continue;
						throw error;
					}
					for (const owner of annotationRegistry.forAnnotation(annotation.id)) {
						if (!owner.isConnected) continue;
						const page = owner.closest<HTMLElement>('.document-page');
						const number = Number(page?.dataset.pageNumber ?? owner.dataset.pageNumber);
						if (!Number.isInteger(number) || number < 1) continue;
						occurrences.push({
							page: number,
							position,
							annotationId: annotation.id,
							itemId: item.itemId
						});
					}
				}
			}
			occurrences.sort(
				(a, b) =>
					a.page - b.page ||
					a.position - b.position ||
					(a.annotationId < b.annotationId ? -1 : a.annotationId > b.annotationId ? 1 : 0) ||
					(a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)
			);
			const byPage = new Map<number, Set<string>>();
			for (const occurrence of occurrences) {
				let ids = byPage.get(occurrence.page);
				if (!ids) byPage.set(occurrence.page, (ids = new Set()));
				ids.add(occurrence.itemId);
			}
			let previous: string[] | undefined;
			// Subscribe after the complete map exists; the controller replays its current pages.
			release = controller.subscribeEagerPages((pages) => {
				if (cancelled) return;
				const ids = [
					...new Set(
						[...pages].sort((a, b) => a - b).flatMap((page) => [...(byPage.get(page) ?? [])])
					)
				];
				if (previous && ids.length === previous.length && ids.every((id, i) => id === previous![i]))
					return;
				previous = ids;
				report(ids);
			});
		});
		return () => {
			cancelled = true;
			release?.();
		};
	});
	const authoringRanges = new Map<
		SourceTarget,
		{
			sourceIndex: NonNullable<typeof snapshot>['source']['sourceIndex'];
			ranges: Range[];
			endpoints: {
				startContainer: Node;
				startOffset: number;
				endContainer: Node;
				endOffset: number;
			}[];
			pages: readonly NonNullable<typeof snapshot>['pages'][number][];
			selectionDocument: NonNullable<typeof snapshot>['selectionDocument'];
		}
	>();
	$effect(() => {
		const root = viewer.documentStageElement,
			commit = pageElementsSnapshot,
			revision = viewer.mountedDomRevision,
			controller = highlights;
		if (
			!root ||
			!commit ||
			!controller ||
			!viewer.pagesVisible ||
			!matchesMountedSnapshot(revision, commit)
		)
			return;
		const selected = new Set(selectedRanges);
		for (const range of authoringRanges.keys())
			if (!selected.has(range)) authoringRanges.delete(range);
		const boundarySelections: { key: string }[] = [];
		const legacyNavigation: { key: string }[] = [];
		const ranges = selectedRanges.flatMap((target) => {
			const index = commit.source.sourceIndex;
			if (!isTextTarget(target)) {
				boundarySelections.push(
					...boundaryTargetBreakGroups(commit.selectionDocument, target).flatMap((group) =>
						breakGroupKeys(group).map((key) => ({ key }))
					)
				);
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
			const candidate = authoringRanges.get(target);
			let resolvedRanges: Range[];
			if (
				!candidate ||
				candidate.sourceIndex !== index ||
				candidate.selectionDocument !== commit.selectionDocument ||
				candidate.ranges.some(
					(range, i) =>
						range.collapsed ||
						!root.contains(range.startContainer) ||
						!root.contains(range.endContainer) ||
						range.startContainer !== candidate.endpoints[i].startContainer ||
						range.startOffset !== candidate.endpoints[i].startOffset ||
						range.endContainer !== candidate.endpoints[i].endContainer ||
						range.endOffset !== candidate.endpoints[i].endOffset
				) ||
				candidate.pages.length !== pages.length ||
				candidate.pages.some((page, i) => page !== pages[i])
			) {
				resolvedRanges = sourceRangeToDomRanges(root, sourceRange, index);
				authoringRanges.set(target, {
					sourceIndex: index,
					ranges: resolvedRanges,
					endpoints: resolvedRanges.map((range) => ({
						startContainer: range.startContainer,
						startOffset: range.startOffset,
						endContainer: range.endContainer,
						endOffset: range.endOffset
					})),
					pages,
					selectionDocument: commit.selectionDocument
				});
			} else resolvedRanges = candidate.ranges;
			legacyNavigation.push(
				...legacyTextNavigationGroups(commit.selectionDocument, target).flatMap((group) =>
					breakGroupKeys(group).map((key) => ({ key }))
				)
			);
			return resolvedRanges;
		});
		controller.setGroup('authoring', 'authoring-selection', ranges);
		controller.setStructuralBoundaryGroup(
			'authoring-structural-boundaries',
			'authoring-selection',
			boundarySelections
		);
		controller.setStructuralBoundaryGroup(
			'authoring-legacy-navigation',
			'authoring-selection',
			legacyNavigation
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
			const occurrence = annotationOccurrence(annotationRegistry, annotationId, { owner });
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
				annotationRegistry.focus(anchor?.owner ?? stage);
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
		const sourceIndex = source.renderSource?.sourceIndex;
		if (!active || !stage || !sourceIndex || hasPanel) return;
		let scrollVersion = 0;
		let commitVersion = 0;
		let cancelled = false;
		const scroller = getDocumentViewportMetrics(stage).scroller;
		if (!scroller) return;
		const onScroll = () => scrollVersion++;
		scroller.addEventListener('scroll', onScroll, { passive: true });
		const unsubscribe = renderer.beforeCommit(() => {
			const generation = ++commitVersion;
			// Editing owns the viewport while a panel is open, including before effects tear down.
			if (hasPanel || source.renderSource?.sourceIndex !== sourceIndex) return;
			const { top: viewportTop, bottom: viewportBottom } = getDocumentViewportMetrics(stage);
			let token: HTMLElement | undefined;
			// Search only visible pages; the page margin may contain no source-bearing text.
			for (const page of stage.querySelectorAll<HTMLElement>('[data-page-number]')) {
				const bounds = page.getBoundingClientRect();
				if (bounds.bottom <= viewportTop) continue;
				if (bounds.top >= viewportBottom) break;
				for (const span of page.querySelectorAll<HTMLElement>(
					'[data-source-start-key]:not([data-generated])'
				)) {
					if (span.dataset.revision && span.dataset.revision !== 'removed') continue;
					const bounds = span.getBoundingClientRect();
					if (bounds.height && bounds.top >= viewportTop && bounds.top < viewportBottom) {
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
			const scrollTop = scroller.scrollTop;
			const capturedScrollVersion = scrollVersion;
			void tick().then(async () => {
				const commit = snapshot;
				await tick();
				if (
					cancelled ||
					generation !== commitVersion ||
					!active ||
					hasPanel ||
					viewer.documentStageElement !== stage ||
					!stage.isConnected ||
					source.renderSource?.sourceIndex !== sourceIndex ||
					!commit ||
					commit.source.sourceIndex !== sourceIndex ||
					snapshot !== commit ||
					mountedGeneration !== commit.id ||
					mountedPages.length !== commit.pages.length ||
					mountedPages.some((page, i) => page !== commit.pages[i]) ||
					scroller.scrollTop !== scrollTop ||
					scrollVersion !== capturedScrollVersion ||
					top === undefined
				)
					return;
				const after = sourcePointBounds(stage, point, true, occurrence)?.top;
				if (after !== undefined && Math.abs(after - top) > 0.5)
					scroller.scrollBy({ top: after - top, behavior: 'instant' });
			});
		});
		return () => {
			cancelled = true;
			unsubscribe();
			scroller.removeEventListener('scroll', onScroll);
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
				error: { message: 'We couldn’t validate the requested document.', cause }
			};
		}
	});
	const hasActiveConflicts = $derived(requestedModel.conflicts.length > 0);
	const sharedProfiles = getDocumentLayoutProfiles();
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
	const visibleHighlightEpoch = $derived(
		current ? snapshot?.layoutEpoch : (renderer.pending?.layoutEpoch ?? snapshot?.layoutEpoch)
	);
	const completeHighlightDocument = $derived.by(() => {
		const commit = pageElementsSnapshot,
			revision = viewer.mountedDomRevision;
		return commit && commit.id === targetGeneration && matchesMountedSnapshot(revision, commit)
			? commit
			: null;
	});
	const highlightDocument = $derived(
		completeHighlightDocument
			? completeHighlightDocument
			: earlyHighlightDocument?.id === targetGeneration &&
				  earlyHighlightDocument.layoutEpoch === visibleHighlightEpoch
				? earlyHighlightDocument
				: null
	);
	const hasHighlightDocument = $derived(Boolean(highlightDocument));
	const highlightAnnotations = $derived(
		!annotationsVisible
			? []
			: annotationItems
				? readableAnnotations(annotationItems, highlightDocument)
				: source.annotations
	);
	const incomplete = $derived(
		!activationComplete &&
			(!pageElementsSnapshot || pageElementsSnapshot.id !== targetGeneration || !current)
	);
	const navigationCapable = $derived(
		active && viewer.layoutPrepared && allowPlaybookNavigation && !picking
	);
	const canOpenPlaybookItems = $derived(
		interacting && viewer.layoutPrepared && current && navigationCapable && playbookNavigationReady
	);
	$effect(() => recordPanelReadiness(canOpenPlaybookItems));
	const documentBackgroundDismissalEnabled = $derived(hasPanel && Boolean(onDocumentBackground));
	$effect(() => {
		documentGestures?.setPolicy({
			clauseActivation: canOpenPlaybookItems,
			discussionActivation: active && Boolean(discussions?.active) && !loading,
			backgroundActivation: documentBackgroundDismissalEnabled
		});
	});
	let layoutElement = $state<HTMLDivElement | null>();
	let panelPosition = $state.raw<{
		target: SourceTarget;
		top: number;
		index: SourceIndex;
		layoutEpoch: string;
		stage: HTMLElement;
		layout: HTMLDivElement;
	}>();
	let panelRequestGeneration = 0;
	let panelOpenPerf = $state.raw<
		| {
				sample: PanelOpenPerfSample;
				annotationId: string;
				selectionToken?: object;
				source: typeof source.renderSource;
		  }
		| undefined
	>();
	let pendingPanelSwitch: {
		from: SourceTarget;
		annotationId: string;
		token?: object;
	} | null = null;
	const panelTop = $derived(panelPosition?.top);
	let panelPositionChange = $state(0);
	let selectedOccurrence = $state.raw<AnnotationOccurrence | null>(null);
	let admittedOccurrence = $state.raw<{
		token: object;
		annotationId: string;
		occurrence: AnnotationOccurrence | null;
	} | null>(null);
	let pageViewport = $state<HTMLDivElement>();
	const loading = $derived(
		!renderer.error &&
			(!pages.length || (active && !viewer.pagesVisible && !viewer.preparationBlocked))
	);
	const presentationOutcome = $derived(
		hasActiveConflicts || (renderer.error && (!pages.length || incomplete))
			? 'error'
			: presented && viewer.layoutPrepared && viewer.pagesVisible && current
				? 'success'
				: 'pending'
	);
	$effect(() => {
		if (active) onPresentation?.(presentationOutcome);
	});
	function pageStackHeight(count: number) {
		return count * PAGE_FORMAT.height + Math.max(0, count - 1) * PAGE_FORMAT.gap;
	}
	const placeholderPages = $derived(Math.max(1, Math.min(3, pages.length)));
	const displayHeight = $derived(
		pageStackHeight(mountedPages.length) + (incomplete && renderer.error ? 64 : 0)
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
					.find((trigger) => sameSourceTarget(trigger.target, target))
			: undefined;
		const fallback = fallbackTrigger
			? [...(source.geometry?.triggerIds.get(fallbackTrigger.id) ?? [])][0]
			: undefined;
		const id =
			annotationId ??
			(fallback
				? displayedAnnotations
						.find((item) => item.itemId === fallback.itemId)
						?.annotations.find((annotation) => annotation.kind === 'trigger')?.id
				: null);
		const point = target && isTextTarget(target) ? target.range.start : undefined;
		return resolveAnnotationAnchor(
			annotationRegistry,
			index,
			id ?? null,
			occurrence?.annotationId === id ? occurrence : null,
			point
		);
	}
	/** Retain source coordinates so focus can return after the editor and preview disappear. */
	function captureAnnotationFocus() {
		const id = selectedAnnotationId,
			occurrence =
				selectionRequest?.status === 'pending' &&
				admittedOccurrence?.token === selectionRequest.token
					? admittedOccurrence.occurrence
					: selectedOccurrence,
			target = panelTarget;
		return () => {
			if (!active) return;
			const anchor = annotationAnchor(id, occurrence, target);
			const owner = anchor?.owner ?? viewer.documentStageElement;
			if (owner) annotationRegistry.focus(owner);
		};
	}
	function restoreAnnotationFocus() {
		captureAnnotationFocus()();
	}
	function currentPanelOpenPerf() {
		const available = active,
			open = hasPanel,
			annotationId = selectedAnnotationId,
			selectionToken = selectionRequest?.token,
			renderSource = source.renderSource,
			owner = panelOpenPerf;
		if (!owner) return;
		if (
			!available ||
			!open ||
			owner.annotationId !== annotationId ||
			owner.selectionToken !== selectionToken ||
			owner.source !== renderSource ||
			owner.sample.contentMountedAt !== undefined
		) {
			panelOpenPerf = undefined;
			return;
		}
		return owner.sample;
	}
	function panelPositionRequest(generation: number) {
		const target = positioningTarget,
			stage = viewer.documentStageElement,
			commit = pageElementsSnapshot,
			index = source.renderSource?.sourceIndex,
			layout = layoutElement,
			epoch = profiler?.epoch;
		if (
			!active ||
			!hasPanel ||
			!target ||
			!stage ||
			!layout ||
			!commit ||
			commit !== snapshot ||
			commit.source.sourceIndex !== index ||
			commit.layoutEpoch !== epoch ||
			mountedPages.length !== commit.pages.length ||
			mountedPages.some((page, i) => page !== commit.pages[i])
		)
			return;
		return {
			target,
			stage,
			layout,
			commit,
			generation,
			index: commit.source.sourceIndex,
			layoutEpoch: commit.layoutEpoch,
			perf: untrack(currentPanelOpenPerf),
			selectionToken: selectionRequest?.token,
			annotationId: selectedAnnotationId
		};
	}
	function panelPositionRequestIsCurrent(
		request: NonNullable<ReturnType<typeof panelPositionRequest>>
	) {
		return (
			request.generation === panelRequestGeneration &&
			active &&
			hasPanel &&
			Boolean(positioningTarget && sameSourceTarget(positioningTarget, request.target)) &&
			viewer.documentStageElement === request.stage &&
			request.stage.isConnected &&
			source.renderSource?.sourceIndex === request.index &&
			profiler?.epoch === request.layoutEpoch &&
			snapshot === request.commit &&
			pageElementsSnapshot === request.commit &&
			mountedPages.length === request.commit.pages.length &&
			mountedPages.every((page, i) => page === request.commit.pages[i]) &&
			layoutElement === request.layout &&
			request.layout.isConnected &&
			selectionRequest?.token === request.selectionToken &&
			selectedAnnotationId === request.annotationId
		);
	}
	function heldPanelPositionMatchesRequest(
		held: typeof panelPosition,
		request: NonNullable<ReturnType<typeof panelPositionRequest>>
	) {
		return Boolean(
			held &&
			sameSourceTarget(held.target, request.target) &&
			held.index === request.index &&
			held.layoutEpoch === request.layoutEpoch &&
			held.stage === request.stage &&
			held.layout === request.layout
		);
	}
	function finishPanelSwitch(target: SourceTarget) {
		const intent = pendingPanelSwitch;
		if (!intent) return;
		const accepted = intent.token
			? selectionRequest?.token === intent.token
			: selectedAnnotationId === intent.annotationId;
		if (accepted && !sameSourceTarget(intent.from, target)) panelPositionChange += 1;
		pendingPanelSwitch = null;
	}
	async function positionPanel(request: NonNullable<ReturnType<typeof panelPositionRequest>>) {
		let perf = request.perf;
		if (perf && currentPanelOpenPerf() !== perf) perf = undefined;
		if (perf) perf.positionRequestedAt = performance.now();
		await tick();
		if (perf && currentPanelOpenPerf() !== perf) perf = undefined;
		if (!panelPositionRequestIsCurrent(request)) return;
		if (perf) perf.domReadyAt = performance.now();
		const lookupStarted = perf ? performance.now() : 0;
		const bounds = panelTargetBounds(request.stage, request.target, request.commit);
		if (perf) {
			perf.lookupMs = performance.now() - lookupStarted;
			perf.preparedSourceFacts = request.commit.panelSourceFacts ? 1 : 0;
			perf.effective = request.commit.view === 'effective' ? 1 : 0;
		}
		// Keep the editor mounted through switches, missing DOM and invalid dirty-draft targets.
		// Only initial opening waits without a fallback position.
		if (!bounds) return;
		const geometryStarted = perf ? performance.now() : 0;
		const top = Math.max(0, bounds.top - request.layout.getBoundingClientRect().top);
		if (perf) perf.geometryMs = performance.now() - geometryStarted;
		panelPosition = {
			target: request.target,
			top,
			index: request.index,
			layoutEpoch: request.layoutEpoch,
			stage: request.stage,
			layout: request.layout
		};
		if (perf) perf.resolvedAt = performance.now();
		finishPanelSwitch(request.target);
	}
	function selectAnnotation(
		itemId: string,
		annotationId: string,
		activation: AnnotationActivation
	) {
		if (!canOpenPlaybookItems) return;
		const perf = createPanelOpenSample();
		const activationSource = source.renderSource;
		panelOpenPerf = undefined;
		const occurrence = annotationOccurrence(annotationRegistry, annotationId, activation);
		const admission = onSelect(itemId, annotationId);
		if (perf) {
			perf.admissionMs = performance.now() - perf.at;
			perf.accepted =
				admission === false || (typeof admission === 'object' && admission.status === 'rejected')
					? 0
					: 1;
			if (perf.accepted) perf.admittedAt = performance.now();
		}
		if (admission === false || (typeof admission === 'object' && admission.status === 'rejected'))
			return;
		if (perf)
			panelOpenPerf = {
				sample: perf,
				annotationId,
				selectionToken: typeof admission === 'object' ? admission.token : undefined,
				source: activationSource
			};
		if (typeof admission === 'object' && admission.status === 'accepted')
			admittedOccurrence = { token: admission.token, annotationId, occurrence };
		else {
			admittedOccurrence = null;
			selectedOccurrence = occurrence;
		}
		pendingPanelSwitch = panelPosition
			? {
					from: panelPosition.target,
					annotationId,
					token: typeof admission === 'object' ? admission.token : undefined
				}
			: null;
	}
	function handleDocumentIntent(intent: DocumentGestureIntent) {
		if (intent.kind === 'activate-background') {
			if (hasPanel) onDocumentBackground?.();
			return;
		}
		if (intent.kind === 'activate-discussion') {
			discussionLayer?.activate(intent.discussionId, true);
			return;
		}
		selectAnnotation(intent.itemId, intent.annotationId, intent.activation);
	}
	$effect(() => {
		const selected = selectedAnnotationId,
			open = hasPanel,
			request = selectionRequest,
			available = active;
		untrack(() => {
			const intent = pendingPanelSwitch;
			if (
				!available ||
				!open ||
				(intent?.token ? request?.token !== intent.token : intent?.annotationId !== selected)
			)
				pendingPanelSwitch = null;
			if (!available) {
				admittedOccurrence = null;
				selectedOccurrence = null;
				return;
			}
			const admitted = admittedOccurrence;
			if (admitted) {
				if (request?.token !== admitted.token) admittedOccurrence = null;
				else if (request.status === 'opened' && open && selected === admitted.annotationId) {
					selectedOccurrence = admitted.occurrence;
					admittedOccurrence = null;
				}
			}
			if (!open || selectedOccurrence?.annotationId !== selected) selectedOccurrence = null;
		});
	});
	$effect(() => {
		const generation = ++panelRequestGeneration;
		const available = active && hasPanel;
		const request = panelPositionRequest(generation);
		untrack(() => {
			if (!available) {
				panelPosition = undefined;
				pendingPanelSwitch = null;
				return;
			}
			if (!request) return;
			const held = panelPosition;
			if (heldPanelPositionMatchesRequest(held, request)) {
				if (request.perf && currentPanelOpenPerf() === request.perf) {
					if (request.perf.resolvedAt === undefined) {
						request.perf.heldPosition = 1;
						request.perf.resolvedAt = performance.now();
					}
					recordPanelContentMounted(request.perf);
				}
				finishPanelSwitch(request.target);
				return;
			}
			// Committed pages retry unresolved/reanchoring targets. Same-target previews do no lookup.
			void positionPanel(request);
		});
		return () => {
			panelRequestGeneration++;
		};
	});
	function recordPanelContentMounted(perf: PanelOpenPerfSample | undefined) {
		if (
			perf &&
			currentPanelOpenPerf() === perf &&
			perf.resolvedAt !== undefined &&
			perf.contentMountedAt === undefined &&
			layoutElement?.querySelector('[data-workspace-panel]')
		) {
			perf.contentMountedAt = performance.now();
			panelOpenPerf = undefined;
		}
	}
	$effect(() => {
		// Effects run after the existing DOM update; diagnostics add no tick or paint wait.
		// Track ownership here without adding dependencies to panel positioning.
		const perf = currentPanelOpenPerf(),
			held = panelPosition;
		if (perf && held)
			untrack(() => {
				if (perf.resolvedAt === undefined) {
					const request = panelPositionRequest(panelRequestGeneration);
					if (
						!request ||
						request.perf !== perf ||
						!panelPositionRequestIsCurrent(request) ||
						!heldPanelPositionMatchesRequest(held, request)
					)
						return;
					perf.heldPosition = 1;
					perf.resolvedAt = performance.now();
				}
				recordPanelContentMounted(perf);
			});
	});
	async function keepPanelVisible() {
		const panel = layoutElement?.querySelector<HTMLElement>('[data-workspace-panel]');
		const held = panelPosition;
		if (!active || !panel || !hasPanel) return;
		await tick();
		if (
			!active ||
			!hasPanel ||
			panelPosition !== held ||
			followScroll ||
			layoutElement?.querySelector('[data-workspace-panel]') !== panel
		)
			return;
		revealInDocumentViewport(panel, { block: 'start-if-hidden', inline: 'none' });
	}
	let wasFollowingScroll = false;
	$effect(() => {
		const following = followScroll;
		if (active && wasFollowingScroll && !following) untrack(() => void keepPanelVisible());
		wasFollowingScroll = following;
	});
	function retryRender() {
		if (onRetry) return onRetry();
		if (!prepare) return;
		source.setSelection(selectedConcessions);
		if (requestedModel.error) {
			renderer.fail(requestedModel.error);
			return;
		}
		if (profiler && source.renderSource && !hasActiveConflicts) {
			onPresentation?.('pending');
			renderer.request({
				source: source.renderSource,
				concessions: selectedConcessions,
				previewChanges,
				priority,
				progressive: !activationComplete,
				profiler
			});
		}
	}
	// Project selection before render effects, independently of preview/layout updates.
	$effect.pre(() => {
		const selection = selectedConcessions;
		untrack(() => source.setSelection(selection));
	});
	$effect(() => {
		const enabled = prepare;
		const selection = selectedConcessions;
		const layoutProfiler = profiler,
			model = source.renderSource,
			preview = previewChanges,
			blocked = hasActiveConflicts,
			error = requestedModel.error,
			stopped = failure;
		untrack(() => {
			if (stopped) {
				renderer.fail(stopped, true);
				return;
			}
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
			renderer.view === 'effective' ||
			!interacting ||
			(source.compactStructure && !hasPanel) ||
			!viewer.layoutPrepared ||
			!current ||
			previewChanges.length ||
			!commit ||
			!layoutProfiler
		)
			return;
		const artifacts = renderer.artifacts;
		if (!artifacts?.compatible(commit.source) || commit.source.materialized) return;
		const focusedItemId = hasPanel
			? displayedAnnotations.find((item) =>
					item.annotations.some((annotation) => annotation.id === selectedAnnotationId)
				)?.itemId
			: undefined;
		return untrack(() =>
			prewarmSavedConcessions(
				commit,
				layoutProfiler,
				artifacts,
				focusedItemId,
				renderer.paginationHistory,
				source.contentOverlays
			)
		);
	});
	function publishMountedDomRevision(generation: number, layoutEpoch: string | undefined) {
		if (!layoutEpoch) return;
		const previous = viewer.mountedDomRevision;
		const selectionDocument = pageElementsSnapshot?.selectionDocument;
		if (
			previous?.generation === generation &&
			previous.layoutEpoch === layoutEpoch &&
			previous.pages === mountedPages &&
			previous.selectionDocument === selectionDocument
		)
			return;
		const revision = {
			id: ++nextMountedDomRevision,
			generation,
			layoutEpoch,
			pages: mountedPages,
			selectionDocument
		};
		// Notify geometry consumers before the new DOM revision can select a highlight snapshot.
		if (highlights) notifyMountedContent(highlights, revision);
		viewer.mountedDomRevision = revision;
	}
	$effect(() => {
		const available = pages,
			generation = targetGeneration,
			commit = current || activationComplete ? snapshot : null,
			epoch = commit?.layoutEpoch ?? renderer.pending?.layoutEpoch,
			enabled = prepare,
			layoutProfiler = profiler,
			warm = activationComplete || (current && untrack(() => mountedGeneration !== generation)),
			failed = failure || renderer.error;
		// Keep already mounted pages while cancelling append/paint work for a failed attempt.
		if (failed) return;
		// Paused retained viewers keep their pages without scheduling more work.
		if (!enabled && retained) return;
		if (!enabled || !layoutProfiler || !generation) {
			if (!warm)
				untrack(() => {
					mountedPages = [];
					mountedGeneration = 0;
					flushedGeneration = 0;
					pageElementsSnapshot = null;
					viewer.mountedDomRevision = null;
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
					if (!abort.signal.aborted) flushedGeneration = generation;
					if (!abort.signal.aborted) publishMountedDomRevision(generation, epoch);
					if (!abort.signal.aborted)
						recordPageMount(generation, startedAt, mountedPages.length, true);
				}
			} else {
				if (mountedPages.some((page, i) => page !== available[i])) {
					mountedPages = [];
					pageElementsSnapshot = null;
					viewer.mountedDomRevision = null;
					mountedGeneration = generation;
					flushedGeneration = 0;
				}
				mountedGeneration = generation;
				while (mountedPages.length < available.length) {
					await layoutProfiler.scheduler.run(
						priority,
						async () => {
							if (abort.signal.aborted) return;
							const startedAt = performance.now();
							const pageCount = mountedPages.length + 1;
							mountedPages = available.slice(0, pageCount);
							await tick();
							if (!abort.signal.aborted) flushedGeneration = generation;
							if (!abort.signal.aborted) publishMountedDomRevision(generation, epoch);
							if (!abort.signal.aborted) recordPageMount(generation, startedAt, pageCount);
						},
						abort.signal,
						() => active || !retained,
						'append'
					);
				}
			}
			await tick();
			if (!abort.signal.aborted) flushedGeneration = generation;
			if (!abort.signal.aborted) publishMountedDomRevision(generation, epoch);
			if (!abort.signal.aborted && commit && mountedPages.length === commit.pages.length) {
				pageElementsSnapshot = commit;
				// Selection metadata can update mounted page content. Publish its revision after that DOM settles.
				await tick();
				if (abort.signal.aborted) return;
				publishMountedDomRevision(generation, commit.layoutEpoch);
				if (completePagesGeneration !== commit.id) {
					completePagesGeneration = commit.id;
					recordDocumentLoadingMilestone('complete-pages-dom-ready', {
						viewer: loadingViewer,
						generation: commit.id,
						pages: mountedPages.length,
						active: active ? 1 : 0
					});
				}
				recordColdStart(active ? 'active-page-elements-ready' : 'background-page-elements-ready');
			}
		}).catch((cause) => {
			// Cleanup owns cancellation; other failures must leave a recoverable presentation.
			if (abort.signal.aborted) return;
			renderer.fail({ message: 'We couldn’t mount the document pages.', cause }, true);
			onFailure?.();
		});
		return () => abort.abort();
	});
	const initialBatchMounted = $derived(
		Boolean(mountedPages.length) &&
			mountedGeneration === targetGeneration &&
			flushedGeneration === targetGeneration &&
			mountedPages.length >= Math.min(3, pages.length) &&
			(current || Boolean(partialEligible && renderer.pending?.initialBatchReady))
	);
	const firstPagesCandidate = $derived.by(() => {
		const display = current ? snapshot : partialEligible ? renderer.pending : null;
		const generation = targetGeneration;
		const firstPages = display?.pages.slice(0, 3);
		if (
			!active ||
			!prepare ||
			!viewer.pagesVisible ||
			loading ||
			!pageViewport ||
			!initialBatchMounted ||
			!display?.layoutEpoch ||
			!generation ||
			!firstPages?.length ||
			mountedGeneration !== generation ||
			flushedGeneration !== generation ||
			firstPages.some((page, index) => mountedPages[index] !== page)
		)
			return null;
		return {
			generation,
			layoutEpoch: display.layoutEpoch,
			source: display.source,
			pages: firstPages
		};
	});
	$effect(() => {
		const generation = targetGeneration;
		if (
			earlyHighlightDocument &&
			(earlyHighlightDocument.id !== generation || Boolean(completeHighlightDocument))
		)
			earlyHighlightDocument = null;
		if (completeHighlightDocument) return;
		const display = current ? snapshot : partialEligible ? renderer.pending : null;
		const epoch = display?.layoutEpoch;
		if (
			!active ||
			!viewer.pagesVisible ||
			!initialBatchMounted ||
			!display ||
			!epoch ||
			!generation ||
			mountedGeneration !== generation ||
			flushedGeneration !== generation
		)
			return;
		const firstPages = mountedPages.slice(0, Math.min(3, display.pages.length));
		if (
			!firstPages.length ||
			firstPages.some((page, index) => page !== display.pages[index]) ||
			(earlyHighlightDocument?.id === generation &&
				earlyHighlightDocument.layoutEpoch === epoch &&
				earlyHighlightDocument.source === display.source)
		)
			return;
		earlyHighlightDocument = {
			id: generation,
			layoutEpoch: epoch,
			view: 'view' in display ? display.view : renderer.view,
			source: display.source,
			concessions: display.concessions,
			pages: firstPages
		};
	});
	let firstPagesGeneration = 0;
	$effect(() => {
		const candidate = firstPagesCandidate;
		const published = viewer.firstPagesReady;
		if (!candidate) {
			if (published) viewer.firstPagesReady = null;
			return;
		}
		if (
			published?.generation === candidate.generation &&
			published.layoutEpoch === candidate.layoutEpoch &&
			published.source === candidate.source &&
			published.pages.length === candidate.pages.length &&
			published.pages.every((page, index) => page === candidate.pages[index])
		)
			return;
		viewer.firstPagesReady = null;
		let cancelled = false;
		void tick().then(() => {
			if (cancelled || firstPagesCandidate !== candidate) return;
			viewer.firstPagesReady = candidate;
			if (documentLoadingPerfEnabled() && firstPagesGeneration !== candidate.generation) {
				firstPagesGeneration = candidate.generation;
				recordDocumentLoadingMilestone('first-pages-dom-ready', {
					viewer: loadingViewer,
					generation: candidate.generation,
					pages: candidate.pages.length
				});
			}
		});
		return () => {
			cancelled = true;
		};
	});
	$effect(() => {
		viewer.pagesVisible = active && (activationComplete || initialBatchMounted);
		viewer.displayedSnapshot =
			viewer.pagesVisible &&
			pageElementsSnapshot &&
			(pageElementsSnapshot.id === targetGeneration || activationComplete)
				? pageElementsSnapshot
				: null;
	});
	$effect(() => {
		const display = current ? snapshot : partialEligible ? renderer.pending : null;
		const generation = display && ('id' in display ? display.id : display.generation);
		viewer.publishExactDisplay(
			active &&
				prepare &&
				!source.issue &&
				!failure &&
				!renderer.error &&
				pageViewport &&
				display?.layoutEpoch &&
				viewer.pagesVisible &&
				mountedPages[0] === display.pages[0] &&
				mountedGeneration === generation &&
				flushedGeneration === generation
				? {
						source: display.source,
						concessions: display.concessions,
						previewChanges: display.previewChanges,
						generation,
						layoutEpoch: display.layoutEpoch
					}
				: null
		);
	});
	$effect(() => {
		renderer.setDisplayActive(active);
		profiler?.scheduler.wake();
		return () => renderer.setDisplayActive(false);
	});
	$effect(() => {
		const generation = targetGeneration;
		const epoch = current ? snapshot?.layoutEpoch : renderer.pending?.layoutEpoch;
		if (!viewer.pagesVisible || !epoch) return;
		const abort = new AbortController();
		void afterPaint(abort.signal)
			.then(() => {
				if (document.hidden) return;
				recordColdStart('first-exact-display');
				renderer.acknowledgeInitialBatchPaint(generation, epoch);
			})
			.catch(() => {});
		return () => abort.abort();
	});
	$effect(() => {
		if (active && viewer.pagesVisible && snapshot && profiler)
			untrack(() => renderer.protectGeometry(profiler!));
	});
	let lastReadySnapshot: typeof snapshot;
	let visibleGeneration = 0;
	$effect(() => {
		const prepared = current && pageElementsSnapshot === snapshot;
		viewer.layoutPrepared = prepared;
		viewer.interactionEnabled = interacting && prepared && !renderer.pending;
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
	const hasRightRail = $derived(
		hasPanel || Boolean(active && discussions?.active && discussions.hasVisibleRail)
	);
	onDestroy(() => {
		panelRequestGeneration++;
		pendingPanelSwitch = null;
		viewer.interactionEnabled = false;
		viewer.pagesVisible = false;
		viewer.firstPagesReady = null;
		viewer.displayedSnapshot = null;
		viewer.mountedDomRevision = null;
		viewer.publishExactDisplay(null);
		viewer.documentStageElement = undefined;
		viewer.retry = undefined;
		viewer.restoreAnnotationFocus = undefined;
		viewer.captureAnnotationFocus = undefined;
		annotationRegistry.clear();
		if (!retained) {
			renderer.destroy();
			source.destroy();
		}
	});
</script>

{#if !sharedProfiles}<LayoutProfileSurface bind:surface />{/if}

{#snippet conflictNotice()}
	{#if hasActiveConflicts && renderer.view === 'effective'}
		<p
			role="alert"
			class="mx-auto max-w-xl rounded-base border-hairline border-edge bg-surface p-4 text-sm"
		>
			This contract version is unavailable. Ask your rep for help.
		</p>
	{:else if hasActiveConflicts}
		<div
			role="alert"
			class="mx-auto max-w-xl rounded border-hairline border-edge bg-surface p-3 shadow-card"
		>
			These applied concessions conflict with current contract changes. Remove an alternative to
			continue.
			{#each requestedModel.conflicts as conflict}
				{@const item = source.items?.find((item) => item._id === conflict.itemId)}
				{@const concession = item?.choices.find(
					(concession) => concession.id === conflict.concession.id
				)}
				<button
					class="ml-2 underline"
					onclick={interacting ? () => onRemoveConcession(conflict.itemId) : undefined}
					>Remove “{concession?.description ?? conflict.concession.id}”{item?.origin.kind ===
						'template' && item.origin.instructions?.summary
						? ` — ${item.origin.kind === 'template' ? item.origin.instructions?.summary : ''}`
						: ''}</button
				>{/each}
		</div>
	{/if}
{/snippet}

<DocumentWorkspaceGeometry {reserveReviewGutter} {hasRightRail} notice={conflictNotice}>
	<div
		class={`viewer-root relative w-full ${active && hasPanel ? '[overflow-anchor:none]' : ''}`}
		style:--document-page-height={`${PAGE_FORMAT.height}px`}
		style:--document-page-horizontal-padding={`${PAGE_FORMAT.horizontalPadding}px`}
		style:--document-page-top-padding={`${PAGE_FORMAT.topPadding}px`}
		style:--document-first-page-top-padding={`${PAGE_FORMAT.firstTopPadding}px`}
		style:--document-page-bottom-padding={`${PAGE_FORMAT.bottomPadding}px`}
		style:--document-content-width={`${PAGE_FORMAT.contentWidth}px`}
		style:--document-page-gap={`${PAGE_FORMAT.gap}px`}
	>
		{#snippet documentContent()}
			{#if mountedPages.length && (viewer.pagesVisible || !renderer.error)}
				<!-- Keep page siblings adjacent; native envelopes reject unowned whitespace. -->
				<!-- prettier-ignore -->
				<div
					class="page-viewport relative isolate w-full shrink-0 focus:outline-none"
					bind:this={pageViewport}
					style:height={`${displayHeight}px`}
				>
					<ReviewTags
						host={pageViewport}
						tags={reviewTags}
						navigation={reviewNavigation}
						onDecision={onReviewDecision}
						ready={interacting && viewer.interactionEnabled}
						visible={active && !loading}
						document={pageElementsSnapshot?.selectionDocument}
						pages={mountedPages}
					/><div
						class="page-stack absolute top-0 left-0 z-1 flex w-(--paper-width) flex-col gap-(--document-page-gap)"
					>
						{#each mountedPages as page (page.number)}
							<DocumentPage
								{page}
								selectionDocument={pageElementsSnapshot?.selectionDocument}
								interactive={active && viewer.interactionEnabled && (interactive || allowPlaybookNavigation)}
								highlights={highlightRects.get(page.number) ?? EMPTY_HIGHLIGHTS}
								{selectedAnnotationId}
								{navigationCapable}
								{canOpenPlaybookItems}
								{structuralBoundaryAnnotations}
								onAnnotationSelect={selectAnnotation}
							/>
						{/each}{#if incomplete && renderer.error}
							<div
								class="px-6 py-3 text-center text-sm text-ink-secondary"
								data-document-chrome
								role="alert"
							>
								This document is incomplete. We couldn’t prepare the remaining pages.
								<button
									type="button"
									class="ml-2 underline"
									onclick={active && (interacting || onRetry) ? retryRender : undefined}>Retry</button
								>
							</div>
						{/if}
					</div>
				</div>
			{:else if renderer.error}
				<LoadingState layout="workspace" class="gap-1.5 text-ink-secondary">
					<strong role="alert" class="font-medium">We couldn’t display this document.</strong>
					<button
						type="button"
						class="underline"
						onclick={active && (interacting || onRetry) ? retryRender : undefined}>Retry</button
					>
				</LoadingState>
			{/if}
		{/snippet}
		<DocumentWorkspaceLayout
			{hasPanel}
			{loading}
			{placeholderPages}
			placeholderGap={PAGE_FORMAT.gap}
			interactive={!loading && active && (interactive || allowPlaybookNavigation)}
			{followScroll}
			documentHeight={loading ? pageStackHeight(placeholderPages) : displayHeight}
			{panelTop}
			{panelPositionChange}
			bind:layoutElement
			bind:documentStageElement={viewer.documentStageElement}
			{documentContent}
			{panelContent}
			{footerContent}
		/>
		{#if documentActions && layoutElement && viewer.documentStageElement}
			{@render documentActions(
				viewer.documentStageElement,
				layoutElement,
				highlights,
				pageElementsSnapshot,
				viewer.mountedDomRevision,
				active && interactive && !loading && viewer.interactionEnabled
			)}
		{/if}
		{#if discussions && layoutElement && viewer.documentStageElement}
			<svelte:boundary
				onerror={() => console.error('Document discussions failed', { stage: 'panel' })}
			>
				<DiscussionLayer
					bind:this={discussionLayer}
					{highlights}
					session={discussions}
					documentRoot={viewer.documentStageElement}
					layout={layoutElement}
					renderRevision={pageElementsSnapshot}
					domRevision={viewer.mountedDomRevision}
					active={active && discussions.active && !loading}
					obscured={hasPanel}
					onActivate={() => onDocumentBackground?.()}
				/>
				{#snippet failed(_error, reset)}
					<div role="alert" class="px-4 py-2 text-xs text-danger">
						Discussions are unavailable. <button class="underline" onclick={reset}>Retry</button>
					</div>
				{/snippet}
			</svelte:boundary>
		{/if}
	</div>
</DocumentWorkspaceGeometry>
