<script lang="ts">
	import CsmIntroduction from './CsmIntroduction.svelte';
	import CsmBookingSkeleton from './CsmBookingSkeleton.svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import { useCsmPreload } from './csm-preload.svelte';
	import { useCsmDialog, type CsmRequest } from './csm-dialog.svelte';
	import { loadCsmModal } from './csm-modal';
	import CsmSupportVideo from './CsmSupportVideo.svelte';
	import { supportVideoOrigin } from './csm-support';
	const dialog = useCsmDialog(),
		preload = useCsmPreload();
	const current = $derived(
		dialog.request && dialog.current(dialog.request) ? dialog.request : undefined
	);
	const content = $derived(dialog.content);
	$effect(() => {
		const poster = preload.poster;
		if (!poster) return;
		// Warm the image even when the dialog won't open soon enough for a preload hint.
		const image = new Image();
		image.fetchPriority = 'high';
		image.src = poster;
	});
	let inProgress = $state(false);
	let admitted = $state.raw<CsmRequest>();
	let completed = $state.raw<CsmRequest>();
	const open = $derived(!!current && (admitted === current || dialog.canStart()));
	$effect(() => {
		if (!current) {
			inProgress = false;
			admitted = undefined;
			completed = undefined;
		}
	});
	const body = loadComponent(
		loadCsmModal,
		() => !!current && admitted === current && dialog.canStart(),
		() => dialog.request
	);
	const BookingBody = $derived(body.component);
</script>

<svelte:head>
	{#if preload.videoPrepared}
		<link rel="preconnect" href={supportVideoOrigin} />
	{/if}
</svelte:head>

{#if content && open}
	<ModalShell
		{open}
		title={current?.initial.replacement ? 'Reschedule your setup call' : 'Get support'}
		variant="panel"
		position="right"
		class="max-w-[600px]"
		onOpen={() => {
			if (!current) return;
			admitted = current;
			preload.warm(current.initial, { video: current.content.video });
		}}
		onClose={() => current && dialog.close(current)}
	>
		<div hidden={inProgress || (!!current && completed === current)}>
			<CsmIntroduction message={content.message} />
			{#if content.video && open && completed !== current}
				{#key content.video.id}
					<CsmSupportVideo video={content.video} />
				{/key}
			{/if}
		</div>
		{#if current && open}
			{#key current}
				{#if BookingBody && admitted === current}
					<BookingBody
						bind:inProgress
						owner={current.owner}
						initial={current.initial}
						content={current.content}
						onBooked={() => {
							completed = current;
							dialog.booked(current);
						}}
						onClose={() => dialog.close(current)}
					/>
				{:else if body.failed}
					<p role="status" class="text-[12.5px] leading-relaxed text-ink-muted">
						Booking is temporarily unavailable. <button
							class="underline"
							onclick={() => body.retry()}>Try again</button
						>
					</p>
				{:else}
					<CsmBookingSkeleton description={content.scheduling} month={current.initial.month} />
				{/if}
			{/key}
		{/if}
	</ModalShell>
{/if}
