<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { FloatingVirtualAnchor } from '$lib/components/ui/floating';
	import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import {
		textTarget,
		type BoundarySourceTarget,
		type SourceRange,
		type SourceTarget,
		type TextSourceTarget
	} from '$lib/contract/source-model';
	import { unitsInRange } from '$lib/contract/ranges';
	import type { RenderSnapshot } from '$lib/document/runtime/types';
	import type {
		AuthoringMode,
		SelectionActions,
		SelectionIssue,
		SelectionAvailability
	} from '$lib/playbook/source-picking';
	import { getDocumentHighlights } from '$lib/document/highlights/controller';
	import {
		mapDomRange,
		sourceRangeToDomRanges
	} from '$lib/document/selection/dom-selection';
	import type { StructuralBoundaryTarget } from '$lib/document/highlights/geometry';
	import { createSelectionInteraction } from '$lib/document/selection/selection-gesture';
	import ArticleIcon from 'phosphor-svelte/lib/ArticleIcon';
	import LightningIcon from 'phosphor-svelte/lib/LightningIcon';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';

	let {
		container,
		snapshot,
		enabled,
		autoConfirm = false,
		onSelectionIssue,
		onActionBlocked,
		onGestureStart,
		evaluate,
		onConfirm
	}: {
		container?: HTMLElement;
		snapshot: RenderSnapshot;
		enabled: boolean;
		autoConfirm?: boolean;
		onSelectionIssue: (issue: SelectionIssue | null) => void;
		onActionBlocked: (reason: string) => void;
		onGestureStart: () => void;
		evaluate: (target: SourceTarget) => SelectionAvailability;
		onConfirm: (target: SourceTarget, mode?: AuthoringMode) => boolean;
	} = $props();
	const actions = [
		{ mode: 'explain', label: 'Explain a clause', icon: ArticleIcon },
		{ mode: 'concession', label: 'Add concession', icon: LightningIcon }
	] as const;
	const index = $derived(snapshot.source.sourceIndex);
	const preserveSelection = (event: PointerEvent) => event.preventDefault();
	let actionStates = $state<SelectionActions | null>(null);
	type TextSelection = {
		kind: 'text';
		target: TextSourceTarget;
		domRange: Range;
	};
	type StructuralBoundarySelection = {
		kind: 'boundary';
		target: BoundarySourceTarget;
		key: string;
		startRatio: number;
		endRatio: number;
	};
	type AcceptedSelection = TextSelection | StructuralBoundarySelection;
	type CommittedSelection = {
		source: AcceptedSelection;
		bounds: DOMRect;
		snapshotId: number;
		domRanges?: Range[];
	};
	type BoundaryGesture = {
		key: string;
		target: BoundarySourceTarget;
		physicalTarget: StructuralBoundaryTarget;
		startX: number;
		startY: number;
		startRatio: number;
		endRatio: number;
		dragging: boolean;
		valid: boolean;
	};
	const BOUNDARY_SELECTION_GROUP = 'structural-boundary-selection';
	const BOUNDARY_DRAG_DISTANCE = 4;
	let committedSelection: CommittedSelection | null = null;
	let boundaryGesture: BoundaryGesture | null = null;
	let toolbarElement = $state<HTMLDivElement>();
	function selectionIsCurrent() {
		if (
			!committedSelection ||
			committedSelection.snapshotId !== snapshot.id ||
			!container?.isConnected
		)
			return false;
		return (
			committedSelection.source.kind === 'text' ||
			Boolean(getDocumentHighlights(container)?.structuralBoundary(committedSelection.source.key))
		);
	}
	function invalidateSelection() {
		releaseSelection?.();
		releaseSelection = undefined;
		getDocumentHighlights(container)?.clearStructuralBoundaryGroup(BOUNDARY_SELECTION_GROUP);
		anchor = null;
		committedSelection = null;
		actionStates = null;
	}
	$effect(() => {
		void snapshot;
		void enabled;
		void container;
		void autoConfirm;
		untrack(() => {
			gesture?.cancel();
			clearBoundaryGesture();
			cancelUpdate();
			invalidateSelection();
			if (!enabled) clearContractSelection();
		});
	});

	let anchor = $state<FloatingVirtualAnchor | null>(null);
	const actionButtons = $state<Partial<Record<AuthoringMode, HTMLButtonElement>>>({});
	let anchorFrame: number | null = null;
	let gesture = $state.raw<ReturnType<typeof createSelectionInteraction>>();
	const anchorListeners = new Set<() => void>();
	let releaseSelection: (() => void) | undefined;

	function cancelUpdate() {
		if (anchorFrame === null) return;
		cancelAnimationFrame(anchorFrame);
		anchorFrame = null;
	}

	function clearContractSelection() {
		const selection = window.getSelection();
		if (
			selection &&
			((selection.anchorNode && container?.contains(selection.anchorNode)) ||
				(selection.focusNode && container?.contains(selection.focusNode)))
		) {
			selection.removeAllRanges();
		}
	}

	function textBounds(ranges: readonly Range[]) {
		return getDocumentHighlights(container)?.rangeBounds(ranges) ?? null;
	}
	function boundaryBounds(selection: StructuralBoundarySelection) {
		return (
			getDocumentHighlights(container)?.structuralBoundarySelectionBounds(
				selection.key,
				selection.startRatio,
				selection.endRatio
			) ?? null
		);
	}

	function sourceRanges(selection: CommittedSelection) {
		if (selection.source.kind !== 'text' || !container) return [];
		const cached = selection.domRanges;
		if (
			cached?.every(
				(range) =>
					container!.contains(range.startContainer) && container!.contains(range.endContainer)
			)
		)
			return cached;
		const ranges = sourceRangeToDomRanges(container, selection.source.target.range, index);
		selection.domRanges = ranges;
		return ranges;
	}
	function currentBounds(selection: CommittedSelection) {
		return selection.source.kind === 'boundary'
			? boundaryBounds(selection.source)
			: textBounds(sourceRanges(selection));
	}
	function initialBounds(source: AcceptedSelection) {
		if (source.kind === 'boundary') return boundaryBounds(source);
		return textBounds([source.domRange]);
	}
	function connectSelection() {
		if (!committedSelection) return;
		const controller = getDocumentHighlights(container);
		if (controller && !releaseSelection)
			releaseSelection = controller.subscribeGeometry(scheduleAnchorUpdate);
	}
	function createAnchor(): FloatingVirtualAnchor {
		return {
			contextElement: container,
			subscribe: (update) => {
				anchorListeners.add(update);
				return () => {
					anchorListeners.delete(update);
				};
			},
			getBoundingClientRect: () => {
				if (!selectionIsCurrent() || !committedSelection) return new DOMRect();
				// Keep the committed rect as the immediate fallback, but project from the live document
				// whenever Floating UI responds to scroll or resize.
				return currentBounds(committedSelection) ?? committedSelection.bounds;
			}
		};
	}
	function publishAnchor() {
		connectSelection();
		if (!anchor) anchor = createAnchor();
		else for (const listener of anchorListeners) listener();
	}
	function updateAnchor() {
		anchorFrame = null;
		if (!enabled || autoConfirm) {
			anchor = null;
			return;
		}
		if (gesture?.selecting) return;
		if (!committedSelection || !selectionIsCurrent()) {
			invalidateSelection();
			return;
		}
		const bounds = currentBounds(committedSelection);
		if (!bounds) return;
		committedSelection.bounds = bounds;
		publishAnchor();
	}

	function scheduleAnchorUpdate() {
		if (gesture?.selecting || anchorFrame !== null) return;
		anchorFrame = requestAnimationFrame(updateAnchor);
	}

	function dismiss() {
		cancelUpdate();
		invalidateSelection();
		onSelectionIssue(null);
		clearContractSelection();
	}

	function confirm(mode?: AuthoringMode) {
		cancelUpdate();
		if (!enabled || !committedSelection || !selectionIsCurrent()) {
			invalidateSelection();
			return;
		}
		// The workflow owns confirmation-time validation and feedback.
		const accepted = onConfirm(committedSelection.source.target, mode);
		invalidateSelection();
		if (accepted) clearContractSelection();
	}

	function select(source: AcceptedSelection, bounds?: DOMRect | null) {
		if (autoConfirm) {
			committedSelection = {
				source,
				bounds: new DOMRect(),
				snapshotId: snapshot.id
			};
			confirm();
			return;
		}
		const permission = evaluate(source.target);
		if (!permission.allowed) {
			if ('reason' in permission) onActionBlocked(permission.reason);
			else onSelectionIssue(permission.issue);
			return;
		}
		onSelectionIssue(null);
		const resolvedBounds = bounds ?? initialBounds(source);
		if (!resolvedBounds) return;
		committedSelection = {
			source,
			bounds: resolvedBounds,
			snapshotId: snapshot.id
		};
		if (source.kind === 'boundary')
			getDocumentHighlights(container)?.setStructuralBoundaryGroup(
				BOUNDARY_SELECTION_GROUP,
				'authoring-selection',
				[
					{
						key: source.key,
						startRatio: source.startRatio,
						endRatio: source.endRatio
					}
				]
			);
		actionStates = permission.actions;
		publishAnchor();
	}
	function boundaryRatio(target: StructuralBoundaryTarget, clientX: number) {
		return Math.max(0, Math.min(1, (clientX - target.bounds.left) / target.bounds.width));
	}
	function paintBoundaryGesture() {
		if (!boundaryGesture?.dragging || !boundaryGesture.valid) return;
		getDocumentHighlights(container)?.setStructuralBoundaryGroup(
			BOUNDARY_SELECTION_GROUP,
			'authoring-selection',
			[
				{
					key: boundaryGesture.key,
					startRatio: boundaryGesture.startRatio,
					endRatio: boundaryGesture.endRatio
				}
			]
		);
	}
	function clearBoundaryGesture() {
		boundaryGesture = null;
		getDocumentHighlights(container)?.clearStructuralBoundaryGroup(BOUNDARY_SELECTION_GROUP);
	}
	function beginBoundaryGesture(event: PointerEvent) {
		if (!enabled || !container) return null;
		const controller = getDocumentHighlights(container);
		const physicalTarget = controller?.structuralBoundaryAt(event.clientX, event.clientY);
		const boundary = physicalTarget
			? index.structuralBoundaries.get(physicalTarget.key)
			: undefined;
		if (!physicalTarget || !boundary) return null;
		// This is a physical margin, never a synthetic text point. Take ownership only after the
		// visible boundary identifies its real preceding source block.
		const ratio = boundaryRatio(physicalTarget, event.clientX);
		const state: BoundaryGesture = {
			key: boundary.afterBlockKey,
			target: { kind: 'boundary', afterBlockKey: boundary.afterBlockKey },
			physicalTarget,
			startX: event.clientX,
			startY: event.clientY,
			startRatio: ratio,
			endRatio: ratio,
			dragging: false,
			valid: true
		};
		return {
			start: () => {
				boundaryGesture = state;
				clearContractSelection();
			},
			move: moveBoundaryGesture,
			finish: finishBoundaryGesture
		};
	}
	function moveBoundaryGesture(event: PointerEvent) {
		if (!boundaryGesture) return;
		const { physicalTarget } = boundaryGesture;
		if (!boundaryGesture.valid) return;
		if (
			Math.hypot(event.clientX - boundaryGesture.startX, event.clientY - boundaryGesture.startY) >=
			BOUNDARY_DRAG_DISTANCE
		)
			boundaryGesture.dragging = true;
		const withinBoundary =
			event.clientY >= physicalTarget.bounds.top &&
			event.clientY <= physicalTarget.bounds.bottom &&
			physicalTarget.bounds.width > 0;
		if (!withinBoundary) {
			boundaryGesture.valid = false;
			getDocumentHighlights(container)?.clearStructuralBoundaryGroup(BOUNDARY_SELECTION_GROUP);
			return;
		}
		boundaryGesture.endRatio = boundaryRatio(physicalTarget, event.clientX);
		paintBoundaryGesture();
	}
	function finishBoundaryGesture(event: PointerEvent | undefined, cancelled = false) {
		if (!boundaryGesture) return;
		if (event) moveBoundaryGesture(event);
		const completed = boundaryGesture.dragging && boundaryGesture.valid && !cancelled;
		const selected = completed
			? {
					kind: 'boundary' as const,
					target: boundaryGesture.target,
					key: boundaryGesture.key,
					startRatio: boundaryGesture.startRatio,
					endRatio: boundaryGesture.endRatio
				}
			: null;
		const bounds = selected ? (boundaryBounds(selected) ?? boundaryGesture.physicalTarget.bounds) : null;
		clearBoundaryGesture();
		if (selected) select(selected, bounds);
		else if (!cancelled) dismiss();
	}

	function hasMeaningfulSourceText(range: SourceRange) {
		try {
			return unitsInRange(index, range).some((unit) => {
				const from = unit.sourceKey === range.start.sourceKey ? range.start.offset : 0;
				const to = unit.sourceKey === range.end.sourceKey ? range.end.offset : unit.length;
				if (to <= from) return false;
				return unit.kind === 'text'
					? Boolean(unit.displayText.slice(from, to).trim())
					: Boolean(unit.displayText.trim());
			});
		} catch {
			return false;
		}
	}
	function completeSelection(range: Range | null) {
		if (!enabled || !container || !range) return;
		const mapped = mapDomRange(range, container, index);
		if (!mapped) {
			onSelectionIssue({ kind: 'unmappable' });
			return;
		}
		if (!hasMeaningfulSourceText(mapped.range)) return;
		select(
			{ kind: 'text', target: textTarget(mapped.range), domRange: mapped.domRange },
			textBounds([mapped.domRange])
		);
	}

	onMount(() => {
		gesture = createSelectionInteraction({
			onNativeStart: () => {
				cancelUpdate();
				invalidateSelection();
				onGestureStart();
			},
			onNativeComplete: completeSelection,
			onCancel: () => {
				dismiss();
			},
			onBoundaryStart: beginBoundaryGesture
		});
		const events = new AbortController();
		const outside = (target: EventTarget | null) =>
			target instanceof Node && !container?.contains(target) && !toolbarElement?.contains(target);
		document.addEventListener(
			'pointerdown',
			(event) => {
				if (committedSelection && !event.defaultPrevented && outside(event.target)) dismiss();
			},
			{ signal: events.signal }
		);
		document.addEventListener(
			'focusin',
			(event) => {
				if (committedSelection && outside(event.target)) dismiss();
			},
			{ signal: events.signal }
		);
		return () => {
			events.abort();
			gesture?.destroy();
			clearBoundaryGesture();
			cancelUpdate();
			releaseSelection?.();
			anchorListeners.clear();
		};
	});

	$effect(() => {
		const interaction = gesture;
		if (!interaction) return;
		interaction.setContainer(enabled ? container : undefined);
		return () => interaction.setContainer(undefined);
	});
</script>

{#if enabled && !autoConfirm && anchor && actionStates}
	<FloatingSurface
		bind:element={toolbarElement}
		open={true}
		{anchor}
		onClose={dismiss}
		placement="bottom"
		gap={10}
		referenceClipping="hide"
		role="group"
		label="Selection actions"
		class="flex h-[34px] items-center rounded-xl border-hairline border-edge bg-surface p-0.5 shadow-floating"
		onpointerdown={preserveSelection}
	>
		{#each actions as action (action.mode)}
			{@const state = actionStates[action.mode]}
			<Tooltip
				text={state.enabled ? action.label : state.reason}
				trigger={actionButtons[action.mode]}
				standalone={false}
				leaveDelay={0}
				onpointerdown={preserveSelection}
			>
				{#snippet children(descriptionId)}
					<SquareIconButton
						bind:element={actionButtons[action.mode]}
						size="sm"
						rounded="xl"
						type="button"
						disabled={!state.enabled}
						aria-describedby={descriptionId}
						onclick={() => {
							confirm(action.mode);
						}}
						aria-label={state.enabled ? action.label : `${action.label}: ${state.reason}`}
					>
						<action.icon aria-hidden="true" size={20} weight="regular" />
					</SquareIconButton>
				{/snippet}
			</Tooltip>
		{/each}
	</FloatingSurface>
{/if}
