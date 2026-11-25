<script lang="ts">
	import type { Snippet } from 'svelte';
	import CsmBookingSkeleton from '$lib/components/chrome/CsmBookingSkeleton.svelte';
	import { browserTimeZone } from '$lib/components/chrome/csm-time';
	import { walkthroughVideos } from '$lib/videos';
	import VideoFacade from '$lib/ui/VideoFacade.svelte';
	import TemplateSetupLayout from './TemplateSetupLayout.svelte';

	let {
		bookingInProgress = false,
		videoInteractive = true,
		children
	}: {
		bookingInProgress?: boolean;
		videoInteractive?: boolean;
		children?: Snippet;
	} = $props();
</script>

<TemplateSetupLayout
	title="Book a call to set up your template"
	description={bookingInProgress
		? undefined
		: "You're almost done. We mostly just need to set up the template for your contracts. Book a 15 minute call and we'll take care of everything."}
>
	{#if !bookingInProgress}
		<VideoFacade
			video={walkthroughVideos.templateSetup}
			interactive={videoInteractive}
			class="mb-8"
		/>
	{/if}
	{#if children}
		{@render children()}
	{:else}
		<CsmBookingSkeleton
			timeZone={browserTimeZone()}
			description="Choose a time to get your template ready together."
			flushTop
		/>
	{/if}
</TemplateSetupLayout>
