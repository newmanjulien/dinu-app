<script lang="ts">
	import PlayIcon from 'phosphor-svelte/lib/PlayIcon';
	import { supportVideoOrigin, type SupportContent } from './csm-support';
	let { video }: { video: NonNullable<SupportContent['video']> } = $props();
	let playing = $state(false);
	function focusPlayer(player: HTMLIFrameElement) {
		player.focus({ preventScroll: true });
	}
</script>

{#if playing}
	<iframe
		use:focusPlayer
		src={`${supportVideoOrigin}/embed/${encodeURIComponent(video.id)}?autoplay=1&rel=0&playsinline=1`}
		title={video.title}
		class="block aspect-video w-full rounded-2xl border-hairline border-line bg-canvas"
		allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
		allowfullscreen
		referrerpolicy="strict-origin-when-cross-origin"
	></iframe>
{:else}
	<button
		type="button"
		aria-label={`Play ${video.title}`}
		class="group relative block aspect-video w-full cursor-pointer overflow-hidden rounded-2xl border-hairline border-line bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
		onclick={() => (playing = true)}
	>
		<img
			src={video.poster}
			alt=""
			width="960"
			height="540"
			loading="eager"
			fetchpriority="high"
			class="absolute inset-0 size-full object-cover"
		/>
		<span class="absolute inset-0 grid place-items-center bg-ink/10 group-hover:bg-ink/20">
			<span
				class="grid size-14 place-items-center rounded-full bg-surface text-ink shadow-floating"
			>
				<PlayIcon weight="fill" class="ml-0.5 size-6" aria-hidden="true" />
			</span>
		</span>
	</button>
{/if}
