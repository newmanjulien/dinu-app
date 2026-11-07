<script lang="ts">
	import { getContractEditors } from '$lib/contract/editors.svelte';
	import { afterNavigate } from '$app/navigation';
	import { getWorkspaceFeedback } from './workspace-feedback.svelte';
	import StatusBubble from './StatusBubble.svelte';
	import { setInteractionOwner, type CloseReason } from '$lib/components/ui/interactions';
	import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
	import { getAdminAuthoringSession } from '$lib/playbook/admin-authoring-session.svelte';
	const sessions = getContractEditors();
	const authoring = getAdminAuthoringSession();
	const feedback = getWorkspaceFeedback();
	setInteractionOwner(Symbol('workspace-save-status'));
	const id = $props.id();
	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();
	const notices = $derived(feedback.notices);
	const label = $derived(authoring.status ?? feedback.label);
	afterNavigate((navigation) => {
		if (navigation.from?.url.href !== navigation.to?.url.href) open = false;
	});
	function close(reason: CloseReason) {
		open = false;
		if (reason === 'escape') trigger?.focus({ preventScroll: true });
	}
</script>

{#if label || open}
	<StatusBubble urgent={Boolean(feedback.attention.length || authoring.needsAttention)}>
		{label ?? 'Saves'}
		{#if notices.length || authoring.status || open}
			<button
				bind:this={trigger}
				type="button"
				aria-expanded={open}
				aria-controls={id}
				class="pointer-events-auto ml-2 cursor-pointer font-medium text-accent underline"
				onclick={() => (open = !open)}>Details</button
			>
		{/if}
	</StatusBubble>
{/if}
<FloatingSurface
	{open}
	{trigger}
	{id}
	role="group"
	label="Saves"
	onClose={close}
	maxWidth={420}
	class="pointer-events-auto w-[min(400px,calc(100vw-24px))] rounded-base border-hairline border-edge bg-surface p-4 shadow-floating"
>
	<div class="mb-3 flex items-center justify-between gap-3">
		<h2 class="text-sm font-medium">Saves</h2>
		<button
			type="button"
			class="text-xs underline"
			onclick={() => {
				open = false;
				trigger?.focus({ preventScroll: true });
			}}>Close</button
		>
	</div>
	{#if !notices.length && !authoring.status}<p class="text-sm text-ink-muted">
			All changes are saved.
		</p>{/if}
	{#if authoring.status}
		<div class="mb-4 text-sm" role="status">
			<p class="font-medium">{authoring.status}</p>
			{#if authoring.message}<p class="mt-1 text-xs text-ink-muted">{authoring.message}</p>{/if}
			<div class="mt-2 flex gap-3 text-xs">
				<a class="underline" href="/admin">Open Admin</a>
				{#if authoring.phase === 'uncertain'}<button
						type="button"
						class="underline"
						onclick={() => authoring.retry()}>Retry confirmation</button
					>{/if}
				{#if authoring.phase === 'confirmed' && (authoring.structureError || authoring.detailError)}<button
						type="button"
						class="underline"
						onclick={() => authoring.retryReads()}>Retry refresh</button
					>{/if}
				{#if authoring.phase === 'recovery'}<button
						type="button"
						class="underline"
						onclick={() => {
							if (window.confirm('Discard the retained instruction draft?'))
								authoring.discardRecovery();
						}}>Discard draft</button
					>{/if}
			</div>
		</div>
	{/if}
	<ul class="space-y-4">
		{#each notices as notice (notice.id)}
			<li class="text-sm">
				<div class="flex items-start justify-between gap-3">
					<span class="min-w-0 break-words font-medium">{notice.name}</span><span
						class="shrink-0 text-xs text-ink-muted">{notice.status}</span
					>
				</div>
				{#if notice.message}<p class="mt-1 text-xs text-ink-muted">{notice.message}</p>{/if}
				{#if notice.memoryOnly}<p role="alert" class="mt-1 text-xs">
						Browser storage is unavailable. Keep this tab open until these changes save.
					</p>{/if}
				{#if notice.status !== 'Saved'}
					<div class="mt-2 flex gap-3 text-xs">
						<a class="underline" href={`/contracts/${notice.id}`}>Open</a>
						{#if notice.status === 'Save failed'}<button
								type="button"
								class="underline"
								onclick={() => sessions.retry(notice.id)}>Retry</button
							>{/if}
					</div>
				{/if}
			</li>
		{/each}
	</ul>
</FloatingSurface>
