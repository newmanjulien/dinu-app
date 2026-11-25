<script lang="ts">
	import { untrack } from 'svelte';
	import type { AuthoringController } from '$lib/playbook/authoring-controller.svelte';
	import type { FloatingVirtualAnchor } from '$lib/components/ui/floating';
	import SelectionToolbar from './SelectionToolbar.svelte';
	import type { RenderSnapshot } from '$lib/document/runtime/types';
	import { getDocumentHighlights } from '$lib/document/highlights/controller';
	import {
		SOURCE_SELECTION,
		getDocumentSelection,
		type SelectionNotice
	} from '$lib/document/selection/document-selection';
	import type { CloseReason } from '$lib/components/ui/interactions';
	let {
		controller,
		container,
		snapshot,
		enabled
	}: {
		controller: AuthoringController;
		container?: HTMLElement;
		snapshot: RenderSnapshot;
		enabled: boolean;
	} = $props();
	const autoConfirm = $derived(controller.textSelectionAutoConfirm);
	let anchor = $state<FloatingVirtualAnchor | null>(null);
	let toolbarElement = $state<HTMLDivElement | null>();
	let committed: object | null = null;
	const anchorListeners = new Set<() => void>();
	function invalidate() {
		committed = null;
		anchor = null;
	}
	function current() {
		const selection = getDocumentSelection(container);
		return enabled &&
			committed &&
			selection?.snapshot === snapshot &&
			selection.value?.candidate?.token === committed
			? selection
			: undefined;
	}
	function dismiss(reason?: CloseReason) {
		invalidate();
		// The document owns the next pointer session, including Shift extension from its anchor.
		if (reason !== 'outside-pointer') getDocumentSelection(container)?.clear(true);
		controller.reportIssue(null);
	}
	function confirm() {
		const selection = current();
		const candidate = committed ? selection?.resolveCandidate(committed) : null;
		if (!candidate) {
			invalidate();
			return;
		}
		const accepted = controller.confirmSelection(candidate);
		invalidate();
		if (accepted) selection?.clear(true);
	}
	function complete(event: Event) {
		const notice = (event as CustomEvent<SelectionNotice>).detail;
		invalidate();
		if (notice.kind === 'start') {
			controller.clearFeedback();
			return;
		}
		if (notice.kind === 'cancel') return;
		if (!enabled || getDocumentSelection(container)?.snapshot !== snapshot) return;
		if (notice.unmappable) {
			controller.reportIssue({ kind: 'unmappable' });
			return;
		}
		const candidate = notice.value?.candidate;
		if (!candidate) return;
		if (autoConfirm) {
			const selection = getDocumentSelection(container);
			if (controller.confirmSelection(candidate)) selection?.clear(true);
			return;
		}
		const permission = controller.selectionEligibility(candidate);
		if (!permission.allowed) {
			if ('reason' in permission) controller.reportBlocked(permission.reason);
			else controller.reportIssue(permission.issue);
			return;
		}
		controller.reportIssue(null);
		committed = candidate.token;
		if (!getDocumentSelection(container)?.bounds()) {
			invalidate();
			return;
		}
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
		const selection = getDocumentSelection(container);
		if (selection?.snapshot === snapshot) return selection.bindToolbar(toolbarElement);
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

{#if enabled && !autoConfirm && anchor}
	<SelectionToolbar
		bind:element={toolbarElement}
		{anchor}
		label={controller.copy.addAction}
		description={controller.copy.addActionDescription}
		onSelect={confirm}
		onClose={dismiss}
	/>
{/if}
