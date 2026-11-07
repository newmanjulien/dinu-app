<script lang="ts">
	import { onMount, tick } from 'svelte';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import Button from '$lib/ui/Button.svelte';
	import CsmBooking from './CsmBooking.svelte';

	import type { CsmOwner } from './csm-preload.svelte';
	import type { CalendarSelection } from './csm-availability';
	let {
		owner,
		initial,
		onBooked,
		onClose,
		onReady
	}: {
		owner: CsmOwner;
		initial: CalendarSelection;
		onBooked: () => void;
		onClose: () => void | Promise<void>;
		onReady: () => void;
	} = $props();
	let completed = $state(false);
	let confirmation = $state<HTMLHeadingElement>();
	onMount(() => onReady());

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
			Your video call with Julien is booked. You can close this window whenever you’re ready.
		</p>
		<Button class="mt-5" onclick={onClose}>Close</Button>
	</div>
{:else}
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
			<p class="mt-2 text-[13px] leading-relaxed text-ink-secondary">
				{#if initial.mode === 'setup'}
					I can help you finish your setup, build your playbook, and get your team ready. Pick a
					time below and we’ll walk through it together.
				{:else}
					Have a question or something blocking you? Book a video call and I’ll help you work
					through it.
				{/if}
			</p>
		</div>
	</div>
	<CsmBooking {owner} {initial} onBooked={booked} />
{/if}
