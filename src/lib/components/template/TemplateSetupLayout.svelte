<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { Role } from '../../../convex/permissions';
	import FileTextIcon from 'phosphor-svelte/lib/FileTextIcon';
	import InfoBar from '$lib/components/ui/InfoBar.svelte';
	import CsmBookingSkeleton from '$lib/components/chrome/CsmBookingSkeleton.svelte';
	import { initialAvailability } from '$lib/components/chrome/csm-preload.svelte';
	let {
		role,
		children,
		bookingInProgress = false
	}: {
		role?: Role;
		children?: Snippet;
		bookingInProgress?: boolean;
	} = $props();
</script>

<main
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-4 pt-14 pb-12 sm:px-6 sm:pt-20 sm:pb-16 md:px-8"
>
	<div
		class="mx-auto max-w-[620px] rounded-base border-hairline border-edge bg-surface p-5 shadow-card sm:p-6"
	>
		<header class="mb-6 text-left">
			<h1 class="text-[19px] leading-6 font-medium text-ink">Set up your company’s template</h1>
			{#if role && !bookingInProgress}
				<p class="mt-1 text-[13px] leading-6 text-ink-muted">
					{#if role === 'admin'}
						Book a call with Julien to get your company’s template ready.
					{:else}
						Your team can start creating contracts once an admin sets up your company’s template.
					{/if}
				</p>
			{/if}
		</header>
		<div>
			{#if children}
				{@render children()}
			{:else if role === 'admin'}
				<CsmBookingSkeleton
					initial={initialAvailability('setup')}
					description="Choose a time to get your template ready together."
				/>
			{:else if role}
				<section
					aria-labelledby="waiting-for-template"
					class="flex min-h-[250px] flex-col items-center justify-center px-6 py-10 text-center"
				>
					<div
						class="mb-4 flex size-11 items-center justify-center rounded-button-xl bg-canvas/80 text-ink-muted"
						aria-hidden="true"
					>
						<FileTextIcon class="size-5.5" />
					</div>
					<h2 id="waiting-for-template" class="text-[14px] leading-6 font-medium text-ink">
						Waiting for your company’s template
					</h2>
					<p class="mt-1 max-w-[360px] text-[13px] leading-6 text-ink-muted">
						Contact an admin on your company team to finish setup.
					</p>
				</section>
				<InfoBar class="mt-4" label="Your admin needs to finish setup.">
					Ask an admin to set up your company’s template.
				</InfoBar>
			{/if}
		</div>
	</div>
</main>
