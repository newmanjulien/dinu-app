<script lang="ts">
	import { adminGuides, repGuides } from '$lib/guides';
	let { role }: { role?: 'admin' | 'rep' } = $props();
	const guides = $derived(role === 'rep' ? repGuides : adminGuides);
</script>

<main
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-4 pt-8 pb-12 text-ink sm:px-6 md:px-8 md:pt-10"
>
	<div class="mx-auto max-w-[61.6rem]">
		<h1 class="mb-6 text-lg font-medium md:mb-7">Guides</h1>
		{#if role}
			<div class="grid gap-x-5 gap-y-12 md:grid-cols-2">
				{#each guides as guide, index (guide.title)}
					<article class="min-w-0">
						<div
							class="relative isolate flex aspect-[1.91] items-center justify-center overflow-hidden rounded-xl bg-[#111110]"
							aria-hidden="true"
						>
							<div
								class="absolute inset-0 -z-10 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px),linear-gradient(to_bottom,#ffffff03_1px,transparent_1px)] bg-size-[30px_30px]"
							></div>
							<div
								class="absolute -inset-x-12 -bottom-20 -z-10 h-36 rounded-[50%] bg-linear-to-r from-amber-600 via-fuchsia-800 to-sky-500 opacity-70 blur-3xl"
								class:hue-rotate-60={index % 2 === 1}
							></div>
							<div class="grid w-2/3 grid-cols-[1fr_minmax(20px,0.8fr)_1fr] items-center">
								{#each guide.icons as Icon, iconIndex}
									{#if iconIndex > 0}<div
											class="h-px bg-linear-to-r from-amber-700/70 via-white/20 to-sky-700/70"
										></div>{/if}
									<div
										class="relative flex aspect-square items-center justify-center rounded-[22%] border border-white/6 bg-linear-to-b from-[#20201f] to-[#191918] shadow-lg"
									>
										<Icon class="size-[42%] text-white/90" weight="light" />
										<span
											class="absolute top-full mt-2.5 w-[160%] text-center text-[10px] text-white/50 sm:text-[11px]"
											>{guide.labels[iconIndex]}</span
										>
									</div>
								{/each}
							</div>
						</div>
						<h2 class="mt-4 text-sm leading-5 font-medium">
							{guide.title}
						</h2>
						<p class="mt-1.5 text-xs leading-5 text-ink-muted">
							{guide.description}
						</p>
					</article>
				{/each}
			</div>
		{/if}
	</div>
</main>
