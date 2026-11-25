<script lang="ts">
	import type { ClassValue } from 'clsx';
	import PlayIcon from 'phosphor-svelte/lib/PlayIcon';
	import { cn } from './cn';
	import { VIDEO_ORIGIN, useVideoPreconnect, type EmbeddedVideo } from './video.svelte';

	let {
		video,
		interactive = true,
		fetchPriority = 'high',
		class: className = ''
	}: {
		video: EmbeddedVideo;
		interactive?: boolean;
		fetchPriority?: 'high' | 'low' | 'auto';
		class?: ClassValue;
	} = $props();

	const preconnect = useVideoPreconnect();
	let playingId = $state<string>();
	const playing = $derived(interactive && playingId === video.id);

	$effect(() => {
		if (!interactive || (playingId !== undefined && playingId !== video.id)) {
			playingId = undefined;
		}
	});

	function focusPlayer(player: HTMLIFrameElement) {
		player.focus({ preventScroll: true });
	}

	function prepare() {
		preconnect?.prepare();
	}

	function play() {
		prepare();
		playingId = video.id;
	}
</script>

{#snippet posterFrame()}
	<img
		src={video.poster}
		alt=""
		width="960"
		height="540"
		loading="eager"
		decoding="async"
		fetchpriority={fetchPriority}
		class="absolute inset-0 size-full object-cover"
	/>
	<span class="absolute inset-0 grid place-items-center bg-ink/10 group-hover:bg-ink/20">
		<span class="grid size-14 place-items-center rounded-full bg-surface text-ink shadow-floating">
			<PlayIcon weight="fill" class="ml-0.5 size-6" aria-hidden="true" />
		</span>
	</span>
{/snippet}

{#if playing}
	<iframe
		use:focusPlayer
		src={`${VIDEO_ORIGIN}/embed/${encodeURIComponent(video.id)}?autoplay=1&rel=0&playsinline=1`}
		title={video.title}
		class={cn(
			'block aspect-video w-full rounded-2xl border-hairline border-line bg-canvas',
			className
		)}
		allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
		allowfullscreen
		referrerpolicy="strict-origin-when-cross-origin"
	></iframe>
{:else if interactive}
	<button
		type="button"
		aria-label={`Play ${video.title}`}
		class={cn(
			'group relative block aspect-video w-full cursor-pointer overflow-hidden rounded-2xl border-hairline border-line bg-canvas focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
			className
		)}
		onpointerenter={prepare}
		onfocus={prepare}
		onclick={play}
	>
		{@render posterFrame()}
	</button>
{:else}
	<div
		aria-hidden="true"
		class={cn(
			'relative block aspect-video w-full overflow-hidden rounded-2xl border-hairline border-line bg-canvas',
			className
		)}
	>
		{@render posterFrame()}
	</div>
{/if}
