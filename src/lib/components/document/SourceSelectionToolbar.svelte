<script lang="ts">
	import { untrack } from 'svelte';
	import type { FloatingVirtualAnchor } from '$lib/components/ui/floating';
	import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import type { SelectionCandidate } from '$lib/document/selection/selection-model';
	import type { RenderSnapshot } from '$lib/document/runtime/types';
	import type {
		AuthoringMode,
		SelectionActions,
		SelectionIssue,
		SelectionAvailability
	} from '$lib/playbook/source-picking';
	import { getDocumentHighlights } from '$lib/document/highlights/controller';
	import {
		SOURCE_SELECTION,
		getDocumentSelection,
		type SelectionNotice
	} from '$lib/document/selection/document-selection';
	import ArticleIcon from 'phosphor-svelte/lib/ArticleIcon';
	import LightningIcon from 'phosphor-svelte/lib/LightningIcon';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import type { CloseReason } from '$lib/components/ui/interactions';
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
		evaluate: (candidate: SelectionCandidate) => SelectionAvailability;
		onConfirm: (candidate: SelectionCandidate, mode?: AuthoringMode) => boolean;
	} = $props();
	const actions = [
		{ mode: 'explain', label: 'Explain a clause', icon: ArticleIcon },
		{ mode: 'concession', label: 'Add concession', icon: LightningIcon }
	] as const;
	const preserveSelection = (event: PointerEvent) => event.preventDefault();
	let actionStates = $state<SelectionActions | null>(null);
	let anchor = $state<FloatingVirtualAnchor | null>(null);
	let toolbarElement = $state<HTMLDivElement>();
	const actionButtons = $state<Partial<Record<AuthoringMode, HTMLButtonElement>>>({});
	let committed: object | null = null;
	const anchorListeners = new Set<() => void>();
	function invalidate() {
		committed = null;
		actionStates = null;
		anchor = null;
	}
	function current() {
		const controller = getDocumentSelection(container);
		return enabled &&
			committed &&
			controller?.snapshot === snapshot &&
			controller.value?.candidate?.token === committed
			? controller
			: undefined;
	}
	function dismiss(reason?: CloseReason) {
		invalidate();
		// The document owns the next pointer session, including Shift extension from its anchor.
		if (reason !== 'outside-pointer') getDocumentSelection(container)?.clear(true);
		onSelectionIssue(null);
	}
	function confirm(mode?: AuthoringMode) {
		const candidate = committed ? current()?.resolveCandidate(committed) : null;
		if (!candidate) {
			invalidate();
			return;
		}

		// Both the current selection policy and the workflow revalidate before authoring.
		const permission = evaluate(candidate);
		if (!permission.allowed || (mode && !permission.actions[mode].enabled)) {
			if (!permission.allowed) {
				if ('reason' in permission) onActionBlocked(permission.reason);
				else onSelectionIssue(permission.issue);
			} else if (mode) {
				const action = permission.actions[mode];
				if (!action.enabled) onActionBlocked(action.reason);
			}
			invalidate();
			return;
		}
		const accepted = onConfirm(candidate, mode);
		invalidate();
		if (accepted) getDocumentSelection(container)?.clear(true);
	}
	function complete(event: Event) {
		const notice = (event as CustomEvent<SelectionNotice>).detail;
		invalidate();
		if (notice.kind === 'start') {
			onGestureStart();
			return;
		}
		if (notice.kind === 'cancel') return;
		if (!enabled || getDocumentSelection(container)?.snapshot !== snapshot) return;
		if (notice.unmappable) {
			onSelectionIssue({ kind: 'unmappable' });
			return;
		}
		const candidate = notice.value?.candidate;
		if (!candidate) return;
		const permission = evaluate(candidate);
		if (!permission.allowed) {
			if ('reason' in permission) onActionBlocked(permission.reason);
			else onSelectionIssue(permission.issue);
			return;
		}
		onSelectionIssue(null);
		committed = candidate.token;
		if (autoConfirm) {
			confirm();
			return;
		}
		if (!getDocumentSelection(container)?.bounds()) {
			invalidate();
			return;
		}
		actionStates = permission.actions;
		anchor = {
			contextElement: container,
			subscribe: (update) => {
				anchorListeners.add(update);
				return () => {
					anchorListeners.delete(update);
				};
			},
			getBoundingClientRect: () => current()?.bounds() ?? new DOMRect()
		};
	}
	$effect(() => {
		if (!toolbarElement) return;
		toolbarElement.setAttribute('data-source-selection-toolbar', '');
		const controller = getDocumentSelection(container);
		if (controller?.snapshot === snapshot) return controller.bindToolbar(toolbarElement);
	});
	$effect(() => {
		void snapshot;
		void autoConfirm;
		const root = enabled ? container : undefined;
		untrack(invalidate);
		if (!root) return;
		root.addEventListener(SOURCE_SELECTION, complete);
		const release = getDocumentHighlights(root)?.subscribeGeometry(() => {
			if (committed && !current()) invalidate();
			else for (const update of anchorListeners) update();
		});
		return () => {
			root.removeEventListener(SOURCE_SELECTION, complete);
			release?.();
			anchorListeners.clear();
		};
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
						class="size-7 rounded-button-lg"
						type="button"
						disabled={!state.enabled}
						aria-describedby={descriptionId}
						onclick={() => {
							confirm(action.mode);
						}}
						aria-label={state.enabled ? action.label : `${action.label}: ${state.reason}`}
					>
						<action.icon aria-hidden="true" class="size-5" weight="regular" />
					</SquareIconButton>
				{/snippet}
			</Tooltip>
		{/each}
	</FloatingSurface>
{/if}
