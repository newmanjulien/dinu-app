<script lang="ts">
	import { getContractSessions } from '$lib/contract/sessions.svelte';
	import { setInteractionOwner, type CloseReason } from '$lib/components/ui/interactions';
	import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
	const sessions = getContractSessions();
	setInteractionOwner(Symbol('workspace-save-status'));
	const id = $props.id();
	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();
	let showProgress = $state(false);
	const notices = $derived(sessions.notices);
	const attention = $derived(
		notices.filter(
			(notice) => ['Save failed', 'Conflict', 'Paused'].includes(notice.status) || notice.memoryOnly
		)
	);
	const progressing = $derived(
		notices.some((notice) => notice.status === 'Saving' || notice.status === 'Checking')
	);
	$effect(() => {
		if (!progressing) {
			showProgress = false;
			return;
		}
		const timer = setTimeout(() => {
			showProgress = true;
		}, 250);
		return () => clearTimeout(timer);
	});
	const label = $derived(
		attention.length
			? `${attention.length} ${attention.length === 1 ? 'contract needs' : 'contracts need'} attention`
			: showProgress
				? notices.some((notice) => notice.status === 'Checking')
					? 'Checking changes…'
					: 'Saving changes…'
				: notices.some((notice) => notice.status === 'Saved')
					? 'Changes saved'
					: null
	);
	function close(reason: CloseReason) {
		open = false;
		if (reason === 'escape') trigger?.focus({ preventScroll: true });
	}
</script>

{#if label || open}
	<button
		bind:this={trigger}
		type="button"
		aria-expanded={open}
		aria-controls={id}
		class="max-w-[45vw] cursor-pointer truncate rounded-button-sm px-2 py-1 text-xs text-ink-muted hover:bg-control-fill focus-visible:outline-2 focus-visible:outline-accent"
		onclick={() => {
			open = !open;
		}}><span role="status">{label ?? 'Contract saves'}</span></button
	>
{/if}
<FloatingSurface
	{open}
	{trigger}
	{id}
	role="group"
	label="Contract saves"
	onClose={close}
	maxWidth={420}
	class="w-[min(400px,calc(100vw-24px))] rounded-base border border-line bg-surface p-4 shadow-md"
>
	<div class="mb-3 flex items-center justify-between gap-3">
		<h2 class="text-sm font-medium">Contract saves</h2>
		<button
			type="button"
			class="text-xs underline"
			onclick={() => {
				open = false;
				trigger?.focus({ preventScroll: true });
			}}>Close</button
		>
	</div>
	{#if !notices.length}<p class="text-sm text-ink-muted">All changes are saved.</p>{/if}
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
						<a
							class="underline"
							href={`/contracts/${notice.id}`}
							onclick={() => {
								open = false;
							}}>Open</a
						>
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
