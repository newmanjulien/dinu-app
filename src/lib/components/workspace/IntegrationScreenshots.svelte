<script lang="ts">
	import { CaretLeftIcon, CaretRightIcon } from 'phosphor-svelte';
	import type { IntegrationScreenshot } from '$lib/integrations';

	let { name, screenshots }: { name: string; screenshots: readonly IntegrationScreenshot[] } =
		$props();
	let track = $state<HTMLDivElement>();
	let viewportWidth = $state(0);
	let atStart = $state(true);
	let atEnd = $state(true);

	function move(direction: -1 | 1) {
		if (!track) return;
		const first = track.children[0];
		const second = track.children[1];
		if (!first || !second) return;
		const step = second.getBoundingClientRect().left - first.getBoundingClientRect().left;
		track.scrollBy({ left: direction * step });
	}

	function updateNavigation() {
		if (!track) return;
		atStart = track.scrollLeft <= 1;
		atEnd = track.scrollLeft >= track.scrollWidth - track.clientWidth - 1;
	}

	$effect(() => {
		if (viewportWidth) updateNavigation();
	});
</script>

{#if screenshots.length}
	<section
		class="relative w-full"
		aria-label={`${name} screenshots`}
		aria-roledescription="carousel"
	>
		<div
			bind:this={track}
			bind:clientWidth={viewportWidth}
			class="flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain [scrollbar-width:none] motion-safe:scroll-smooth [&::-webkit-scrollbar]:hidden"
			onscroll={updateNavigation}
		>
			{#each screenshots as screenshot, index (screenshot.src)}
				<div
					class="w-[85%] max-w-[760px] shrink-0 snap-start overflow-hidden rounded-xl border border-edge/50 bg-surface"
					role="group"
					aria-roledescription="slide"
					aria-label={`${index + 1} of ${screenshots.length}`}
				>
					<img
						src={screenshot.src}
						alt={screenshot.alt}
						width={screenshot.width}
						height={screenshot.height}
						loading={index === 0 ? 'eager' : 'lazy'}
						decoding="async"
						class="aspect-[5/3] w-full object-contain"
					/>
				</div>
			{/each}
		</div>
		{#if screenshots.length > 1}
			<button
				type="button"
				aria-label="Previous screenshot"
				class="absolute top-1/2 -left-4 grid h-11 w-4 -translate-y-1/2 cursor-pointer place-items-center rounded-sm text-ink-muted hover:text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-35 sm:-left-6 sm:w-6"
				disabled={atStart}
				onclick={() => move(-1)}
			>
				<CaretLeftIcon class="size-4 sm:size-5" aria-hidden="true" />
			</button>
			<button
				type="button"
				aria-label="Next screenshot"
				class="absolute top-1/2 -right-4 grid h-11 w-4 -translate-y-1/2 cursor-pointer place-items-center rounded-sm text-ink-muted hover:text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-35 sm:-right-6 sm:w-6"
				disabled={atEnd}
				onclick={() => move(1)}
			>
				<CaretRightIcon class="size-4 sm:size-5" aria-hidden="true" />
			</button>
		{/if}
	</section>
{/if}
