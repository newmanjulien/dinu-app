<script lang="ts">
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import CsmBookingSkeleton from './CsmBookingSkeleton.svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import { useCsmPreload } from './csm-preload.svelte';
	import { useCsmDialog, type CsmRequest } from './csm-dialog.svelte';
	import { loadCsmModal } from './csm-modal';
	import CsmSupportVideo from './CsmSupportVideo.svelte';
	const dialog = useCsmDialog(),
		preload = useCsmPreload();
	const current = $derived(
		dialog.request && dialog.current(dialog.request) ? dialog.request : undefined
	);
	const content = $derived(dialog.content);
	let admitted = $state.raw<CsmRequest>();
	let completed = $state.raw<CsmRequest>();
	const open = $derived(!!current && (admitted === current || dialog.canStart()));
	$effect(() => {
		if (!current) {
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
			if (!current.initial.replacement) preload.warm(current.initial);
			current.onOpen?.();
		}}
		onClose={() => current && dialog.close(current)}
	>
		<div hidden={!!current && completed === current}>
			<div class="flex items-start gap-3 rounded-2xl border-hairline border-line p-4">
				<Avatar
					name="Julien Newman"
					avatarUrl="/delegation-julien.jpg"
					fallbackUrl={null}
					class="size-11"
					decorative
				/>
				<div class="min-w-0">
					<h3 class="text-[13px] font-medium">Julien Newman</h3>
					<p class="mt-2 text-[13px] leading-relaxed text-ink-secondary">{content.message}</p>
				</div>
			</div>
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
					<CsmBookingSkeleton description={content.scheduling} />
				{/if}
			{/key}
		{/if}
	</ModalShell>
{/if}
