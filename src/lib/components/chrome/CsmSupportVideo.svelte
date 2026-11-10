<script lang="ts">
	import type { SupportContent } from './csm-support';
	let { video }: { video: NonNullable<SupportContent['video']> } = $props();
	let loaded = $state(false);
</script>

<div
	class="relative mt-5 aspect-video overflow-hidden rounded-2xl border-hairline border-line bg-canvas"
>
	{#if loaded}
		<iframe
			src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(video.id)}?rel=0&playsinline=1`}
			title={video.title}
			class="size-full border-0"
			allow="encrypted-media; picture-in-picture; fullscreen"
			allowfullscreen
			referrerpolicy="strict-origin-when-cross-origin"
		></iframe>
	{:else}
		<div class="flex size-full flex-col items-center justify-center gap-3 p-5 text-center">
			<p class="text-sm font-medium">{video.title}</p>
			<p class="text-xs text-ink-secondary">
				Loading this video connects to YouTube and shares your network information with Google.
			</p>
			<button
				type="button"
				class="rounded-md border border-line bg-surface px-3 py-2 text-xs"
				onclick={() => (loaded = true)}>Load video</button
			>
		</div>
	{/if}
</div>
<a
	href={`https://www.youtube.com/watch?v=${encodeURIComponent(video.id)}`}
	target="_blank"
	rel="noopener noreferrer"
	class="mt-2 inline-block text-xs text-ink-secondary underline">Watch on YouTube</a
>
