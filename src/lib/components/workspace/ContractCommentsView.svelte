<script lang="ts">
	import { onDestroy, onMount, untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { waitForRead } from '$lib/auth/attempt';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import type { ContractEditor } from '$lib/contract/editors.svelte';
	import type { ContractBuyerLink } from '$lib/contract/saved';
	import { createDocumentWorkspace } from '$lib/document/runtime/workspace-factory';
	import {
		setDocumentWorkspace,
		type DocumentWorkspace
	} from '$lib/document/runtime/workspace-context';
	import {
		documentAnnotations,
		filterOverlappedExplanations,
		toAppliedOverlayItems,
		type AppliedOverlay
	} from '$lib/playbook/document-overlay';
	import { isBuyerItem, isRepItem } from '$lib/playbook/model';
	import { setInteractionOwner } from '$lib/components/ui/interactions';
	import { setAnnotationLabel } from '$lib/document/annotation-label';
	import { DiscussionSession } from '$lib/discussions/session.svelte';
	import DocumentViewer from '$lib/components/document/DocumentViewer.svelte';
	import DocumentPanelCard from '$lib/components/document/DocumentPanelCard.svelte';
	import DocumentPanelBody from '$lib/components/document/DocumentPanelBody.svelte';
	import ClauseText from '$lib/components/playbook/ClauseText.svelte';
	import BoxDismissal from '$lib/components/playbook/BoxDismissal.svelte';
	import Button from '$lib/ui/Button.svelte';

	let {
		editor,
		buyerLink,
		active = true,
		paused = false,
		interactionAdmitted = true,
		hasPendingChanges = false,
		onFrame
	}: {
		editor: ContractEditor;
		buyerLink: ContractBuyerLink;
		active?: boolean;
		paused?: boolean;
		interactionAdmitted?: boolean;
		hasPendingChanges?: boolean;
		onFrame?: (frame: { workspace: DocumentWorkspace; interactionOwner: symbol }) => () => void;
	} = $props();

	const client = useConvexClient();
	const viewer = useViewer();
	const session = useViewerSession();
	const membershipId = viewer().membership.id;
	const contractId = untrack(() => editor.id as Id<'savedContracts'>);

	const appliedOverlays = $derived.by((): AppliedOverlay[] => {
		const snapshot = editor.snapshot;
		if (!snapshot) return [];
		const concessions = buyerLink.concessions;
		return snapshot.items.flatMap((item) => {
			if (!isRepItem(item)) return [];
			const optionId = concessions[item._id];
			if (!optionId) return [];
			const concession = item.concessions.find((c) => c.id === optionId);
			if (!concession) return [];
			return [
				{
					itemId: item._id,
					trigger: item.trigger,
					concessions: [{ id: concession.id, changes: concession.changes }]
				}
			];
		});
	});
	const overlayItems = $derived(toAppliedOverlayItems(appliedOverlays));
	const appliedOverlaysKey = $derived(JSON.stringify(appliedOverlays));
	const rawExplanations = $derived.by(() => {
		const snapshot = editor.snapshot;
		if (!snapshot) return [];
		return snapshot.items.flatMap((item) =>
			isBuyerItem(item)
				? [{ itemId: item._id, trigger: item.trigger, explanation: item.explanation }]
				: []
		);
	});

	const workspace = setDocumentWorkspace(
		createDocumentWorkspace(
			{
				kind: 'overlays',
				contract: true,
				blocks: { data: untrack(() => editor.snapshot?.blocks) },
				overlays: untrack(() => overlayItems)
			},
			'effective'
		)
	);
	const interactionOwner = setInteractionOwner(Symbol('contract-comments'));
	setAnnotationLabel('explanation');

	$effect(() => onFrame?.({ workspace, interactionOwner }));

	let acceptedBlocks = untrack(() => editor.snapshot?.blocks);
	let acceptedOverlaysKey = untrack(() => appliedOverlaysKey);
	let acceptedConcessionsKey = '';
	$effect(() => {
		const blocks = editor.snapshot?.blocks;
		const overlays = overlayItems;
		const concessions = buyerLink.concessions;
		const overlaysKey = appliedOverlaysKey;
		const concessionsKey = JSON.stringify(concessions);
		untrack(() => {
			if (blocks !== acceptedBlocks || overlaysKey !== acceptedOverlaysKey) {
				acceptedBlocks = blocks;
				acceptedOverlaysKey = overlaysKey;
				workspace.accept({
					kind: 'overlays',
					contract: true,
					blocks: { data: blocks },
					overlays
				});
				acceptedConcessionsKey = '';
			}
			if (concessionsKey !== acceptedConcessionsKey) {
				acceptedConcessionsKey = concessionsKey;
				workspace.source.setSelection(concessions);
			}
		});
	});

	const explanations = $derived.by(() => {
		const compiled = workspace.source.compiled;
		if (!compiled) return [];
		return filterOverlappedExplanations(
			compiled.index,
			rawExplanations,
			overlayItems,
			buyerLink.concessions
		);
	});
	const summaries = $derived(
		explanations
			.filter((item) => item.explanation.trim())
			.map((item) => ({
				itemId: item.itemId,
				annotations: documentAnnotations({
					_id: item.itemId,
					audience: 'buyer',
					trigger: item.trigger,
					concessions: []
				})
			}))
	);

	let connected = $state(false);
	onMount(() => {
		connected = client.connectionState().isWebSocketConnected;
		return client.subscribeToConnectionState((state) => {
			connected = state.isWebSocketConnected;
		});
	});

	const discussions = new DiscussionSession(
		client,
		{ kind: 'seller', membershipId, id: contractId },
		() => buyerLink.contentRevision,
		{
			policy: () => ({
				readOnly: !active || !interactionAdmitted || session.blocked,
				generation: session.transportGeneration
			}),
			buyerName: () => editor.buyerName,
			missingSellerName: () => !viewer().profile.name.trim()
		}
	);
	$effect(() => {
		const enabled = !paused && interactionAdmitted && !session.blocked;
		untrack(() => discussions.setActive(enabled));
	});
	let lastTransportGeneration = session.transportGeneration;
	$effect(() => {
		const generation = session.transportGeneration;
		const enabled = !paused && interactionAdmitted && !session.blocked;
		untrack(() => {
			if (generation !== lastTransportGeneration) {
				lastTransportGeneration = generation;
				if (enabled && discussions.error) discussions.retry();
			}
		});
	});
	$effect(() => {
		const canRead =
			active &&
			!paused &&
			interactionAdmitted &&
			!session.blocked &&
			connected &&
			discussions.authorized;
		const readIdentity = canRead
			? JSON.stringify([
					session.preparedSessionId,
					membershipId,
					contractId,
					session.transportGeneration
				])
			: undefined;
		untrack(() => {
			if (readIdentity) {
				discussions.reads.configure(readIdentity, async (messages) => {
					await waitForRead(
						client.mutation(api.discussions.markSeen, {
							membershipId,
							id: contractId,
							operationId: crypto.randomUUID(),
							messages
						}),
						AbortSignal.timeout(15_000)
					);
					return true;
				});
			} else {
				discussions.reads.configure();
			}
		});
	});

	let selectedId = $state<string | null>(null);
	let selectedAnnotationId = $state<string | null>(null);
	const selected = $derived(explanations.find((item) => item.itemId === selectedId));
	let animateExplanationContent = $state(false);
	function close(restore = true) {
		const focus = restore ? workspace.viewer.captureAnnotationFocus?.() : undefined;
		animateExplanationContent = false;
		selectedId = null;
		selectedAnnotationId = null;
		if (focus) focus();
	}
	$effect(() => {
		if (!active) {
			untrack(() => {
				close(false);
				discussions.selected = null;
			});
		}
	});
	$effect(() => {
		if (selectedId && !selected) {
			animateExplanationContent = false;
			selectedId = null;
			selectedAnnotationId = null;
		}
	});

	onDestroy(() => {
		discussions.destroy();
		workspace.renderer.destroy();
		workspace.source.destroy();
	});
</script>

<BoxDismissal
	owner={interactionOwner}
	active={active && Boolean(selected)}
	onDismiss={(restore) => close(restore)}
/>
{#snippet panelContent()}
	{#if selected?.explanation.trim()}
		<DocumentPanelCard label="Clause explanation">
			<DocumentPanelBody>
				{#key selected.itemId}
					<ClauseText text={selected.explanation} animateContent={animateExplanationContent} />
				{/key}
			</DocumentPanelBody>
		</DocumentPanelCard>
	{/if}
{/snippet}

{#if hasPendingChanges}
	<p
		role="status"
		class="mx-auto mb-3 max-w-3xl px-6 text-center text-[13px] leading-5 text-ink-muted"
	>
		Showing the buyer’s current version. Unsaved or unapproved changes in Negotiate will sync
		automatically once saved and approved.
	</p>
{/if}

<svelte:boundary
	onerror={() => {
		console.error('Contract comments view failed');
	}}
>
	{#if workspace.source.issue}
		<p role="alert" class="p-8 text-center text-sm">
			This contract’s buyer view is unavailable right now.
		</p>
	{:else}
		<DocumentViewer
			{discussions}
			active={active && interactionAdmitted}
			foreground={active && interactionAdmitted}
			prepare={!paused}
			priority={() => (active && interactionAdmitted ? 'foreground' : 'background')}
			interactive={active && interactionAdmitted && !session.blocked}
			retained
			{panelContent}
			annotationItems={summaries}
			selectedConcessions={buyerLink.concessions}
			hasPanel={Boolean(selected)}
			{selectedAnnotationId}
			panelTarget={selected?.trigger.target}
			onSelect={(itemId, annotationId) => {
				if (!active || !explanations.find((i) => i.itemId === itemId)?.explanation.trim())
					return false;
				const changed = selectedId !== itemId;
				animateExplanationContent = Boolean(selected) && changed;
				selectedId = itemId;
				selectedAnnotationId = annotationId;
				return true;
			}}
			onDocumentBackground={() => close(false)}
		/>
	{/if}
	{#snippet failed(_error, reset)}
		<div role="alert" class="flex items-center justify-center gap-3 px-4 py-8 text-sm text-danger">
			<span>Comments are unavailable right now.</span>
			<Button variant="secondary" onclick={reset}>Try again</Button>
		</div>
	{/snippet}
</svelte:boundary>
