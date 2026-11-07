<script lang="ts">
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import { useCsmPreload } from './csm-preload.svelte';
	import { useCsmDialog } from './csm-dialog.svelte';
	import { loadCsmModal } from './csm-modal';
	const dialog = useCsmDialog(),
		preload = useCsmPreload();
	let frameAdmitted = $state(false),
		bodyAdmitted = $state(false);
	const body = loadComponent(
		loadCsmModal,
		() =>
			Boolean(
				dialog.request && dialog.current(dialog.request) && frameAdmitted && dialog.canStart()
			),
		() => dialog.request
	);
	const BookingBody = $derived(body.component);
</script>

{#if dialog.request && dialog.current(dialog.request) && (frameAdmitted || dialog.canStart())}
	{@const current = dialog.request}
	<ModalShell
		title={current.initial.replacement
			? 'Reschedule your setup call'
			: current.initial.mode === 'setup'
				? 'Delegate a task'
				: 'Get support'}
		variant="panel"
		position="right"
		class="max-w-[600px]"
		onOpen={() => {
			frameAdmitted = true;
			if (!current.initial.replacement) preload.warm(current.initial);
			current.onOpen?.();
		}}
		onClose={() => dialog.close(current)}
	>
		{#if BookingBody && frameAdmitted && (bodyAdmitted || dialog.canStart())}
			<BookingBody
				onReady={() => (bodyAdmitted = true)}
				owner={current.owner}
				initial={current.initial}
				onBooked={() => dialog.booked(current)}
				onClose={() => dialog.close(current)}
			/>
		{:else if body.failed}
			<p role="status" class="text-[12.5px] leading-relaxed text-ink-muted">
				Booking is temporarily unavailable. Please close this window and try again later.
			</p>
		{:else}
			<p role="status" class="text-[12.5px] text-ink-muted">Loading calendar…</p>
		{/if}
	</ModalShell>
{/if}
