<script lang="ts">
	import { untrack } from 'svelte';
	import type { TemplateAudience } from '$lib/playbook/model';
	import { templateCopy } from '$lib/playbook/template-copy';
	import type { FloatingVirtualAnchor } from '$lib/components/ui/floating';
	import SelectionToolbar from './SelectionToolbar.svelte';
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
	import EnvelopeSimpleIcon from 'phosphor-svelte/lib/EnvelopeSimpleIcon';
	import LightningIcon from 'phosphor-svelte/lib/LightningIcon';
	import CopySimpleIcon from 'phosphor-svelte/lib/CopySimpleIcon';
	import type { CloseReason } from '$lib/components/ui/interactions';
	let {
		audience = 'rep',
		container,
		snapshot,
		enabled,
		autoConfirm = false,
		onSelectionIssue,
		onActionBlocked,
		onGestureStart,
		evaluate,
		onConfirm,
		onCandidate,
		copyRepSummary
	}: {
		audience?: TemplateAudience;
		container?: HTMLElement;
		snapshot: RenderSnapshot;
		enabled: boolean;
		autoConfirm?: boolean;
		onSelectionIssue: (issue: SelectionIssue | null) => void;
		onActionBlocked: (reason: string) => void;
		onGestureStart: () => void;
		evaluate: (candidate: SelectionCandidate) => SelectionAvailability;
		onConfirm: (candidate: SelectionCandidate, mode?: AuthoringMode) => boolean;
		onCandidate?: (candidate: SelectionCandidate | null) => void;
		copyRepSummary?: {
			enabled: boolean;
			reason: string;
			run: (candidate: SelectionCandidate, current: () => boolean) => Promise<boolean>;
		};
	} = $props();
	const actions = $derived([
		{ mode: 'add-item', label: templateCopy(audience).addAction, icon: EnvelopeSimpleIcon },
		copyRepSummary
			? { mode: 'copy-rep-summary' as const, label: 'Copy rep summary', icon: CopySimpleIcon }
			: { mode: 'concession' as const, label: 'Add concession', icon: LightningIcon }
	] as const);
	let actionStates = $state<SelectionActions | null>(null);
	let anchor = $state<FloatingVirtualAnchor | null>(null);
	let toolbarElement = $state<HTMLDivElement | null>();
	let committed: object | null = null;
	const anchorListeners = new Set<() => void>();
	function invalidate() {
		committed = null;
		actionStates = null;
		anchor = null;
		onCandidate?.(null);
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
	async function confirm(mode?: AuthoringMode | 'copy-rep-summary') {
		const candidate = committed ? current()?.resolveCandidate(committed) : null;
		if (!candidate) {
			invalidate();
			return;
		}

		// Both the current selection policy and the workflow revalidate before authoring.
		const permission = evaluate(candidate);
		const action =
			mode === 'copy-rep-summary'
				? copyRepSummary
				: mode && permission.allowed
					? permission.actions[mode]
					: undefined;
		if (!permission.allowed || (mode && !action?.enabled)) {
			if (!permission.allowed) {
				if ('reason' in permission) onActionBlocked(permission.reason);
				else onSelectionIssue(permission.issue);
			} else if (mode) {
				if (action && !action.enabled) onActionBlocked(action.reason);
			}
			invalidate();
			return;
		}
		const controller = current();
		const token = committed;
		const accepted =
			mode === 'copy-rep-summary'
				? await copyRepSummary!.run(candidate, () => committed === token && Boolean(current()))
				: onConfirm(candidate, mode);
		if (committed !== token) return;
		invalidate();
		if (accepted) controller?.clear(true);
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
		onCandidate?.(candidate);
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
	<SelectionToolbar
		bind:element={toolbarElement}
		{anchor}
		onClose={dismiss}
		actions={actions.map((action) => {
			const state =
				action.mode === 'copy-rep-summary' ? copyRepSummary! : actionStates![action.mode];
			return {
				id: action.mode,
				label: action.label,
				icon: action.icon,
				enabled: state.enabled,
				reason: state.enabled ? undefined : 'Disabled for this clause',
				onSelect: () => {
					void confirm(action.mode);
				}
			};
		})}
	/>
{/if}
