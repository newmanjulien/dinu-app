<script lang="ts">
	import { tick } from 'svelte';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
	import Button from '$lib/ui/Button.svelte';
	import CsmBooking from './CsmBooking.svelte';
	import type { SupportContent } from './csm-support';

	import type { CsmOwner } from './csm-preload.svelte';
	import type { AvailabilitySelection } from './csm-availability';
	let {
		owner,
		initial,
		content,
		onBooked,
		inProgress = $bindable(false),
		onClose
	}: {
		owner: CsmOwner;
		initial: AvailabilitySelection;
		content: SupportContent;
		onBooked: () => void;
		inProgress?: boolean;
		onClose: () => void | Promise<void>;
	} = $props();
	let completed = $state(false);
	let confirmation = $state<HTMLHeadingElement>();
	async function booked() {
		if (completed) return;
		completed = true;
		onBooked();
		await tick();
		confirmation?.focus({ preventScroll: true });
	}
</script>

{#if completed}
	<div class="rounded-lg border-hairline border-line p-6">
		<CheckCircleIcon class="size-9 text-success" aria-hidden="true" />
		<h3 bind:this={confirmation} tabindex="-1" class="mt-4 text-[16px] font-medium outline-none">
			Your call is booked
		</h3>
		<p class="mt-2 text-[13px] leading-relaxed text-ink-secondary">
			Your video link will be added to your calendar invitation shortly. You can close this window
			whenever you’re ready.
		</p>
		<Button class="mt-5" onclick={onClose}>Close</Button>
	</div>
{:else}
	<CsmBooking
		{owner}
		{initial}
		bind:inProgress
		flushTop={!content.video}
		description={content.scheduling}
		onBooked={booked}
	/>
{/if}
