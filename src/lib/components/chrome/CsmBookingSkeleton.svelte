<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let { description }: { description: string } = $props();
</script>

<div class="mt-8 @container" aria-busy="true">
	<span role="status" class="sr-only">Loading calendar</span>
	<div aria-hidden="true">
		<SkeletonBlock class="w-fit text-[15px] font-medium">Schedule a call with Julien</SkeletonBlock>
		<SkeletonBlock class="mt-1 w-fit text-[13px]">{description}</SkeletonBlock>
		<SkeletonBlock class="mt-3 w-fit text-[12.5px] leading-relaxed">Loading calendar…</SkeletonBlock
		>
		<div
			class="mt-5 grid grid-cols-1 rounded-xl border-hairline border-line @min-[520px]:grid-cols-[minmax(0,1fr)_208px]"
		>
			<div class="min-w-0 px-4 py-3 @max-[290px]:px-2">
				<div class="mb-2 flex h-[31px] items-center justify-between gap-2">
					<SkeletonBlock class="h-4 w-28" />
					<div class="flex gap-1">
						<SkeletonBlock class="size-[31px]" /><SkeletonBlock class="size-[31px]" />
					</div>
				</div>
				<div class="grid grid-cols-7 justify-items-center">
					{#each Array(7) as _, day (day)}
						<div class="grid h-7 place-items-center"><SkeletonBlock class="size-2" /></div>
					{/each}
					{#each Array(35) as _, date (date)}
						<div class="w-full p-0.5"><SkeletonBlock class="h-7 w-full rounded-md" /></div>
					{/each}
				</div>
			</div>
			<div
				class="flex min-w-0 flex-col border-t-[length:var(--surface-border-width)] border-line px-4 py-3 @min-[520px]:col-start-2 @min-[520px]:row-start-1 @min-[520px]:min-h-0 @min-[520px]:border-t-0 @min-[520px]:border-l-[length:var(--surface-border-width)] @min-[520px]:[contain:size] @max-[290px]:px-2"
			>
				<div class="mb-3 flex min-h-8 shrink-0 items-center">
					<SkeletonBlock class="h-4 w-28" />
				</div>
				<div
					class="-m-0.5 min-h-0 max-h-37 overflow-hidden p-0.5 [scrollbar-gutter:stable] @min-[520px]:max-h-none"
				>
					<div class="space-y-2">
						{#each [0, 1, 2, 3] as slot (slot)}<SkeletonBlock
								class="h-11 w-full rounded-md"
							/>{/each}
					</div>
				</div>
			</div>
			<div
				class="col-span-full flex min-w-0 items-center gap-2.5 border-t-[length:var(--surface-border-width)] border-line px-4 py-3 @min-[520px]:row-start-2 @max-[290px]:flex-col @max-[290px]:items-stretch @max-[290px]:gap-1 @max-[290px]:px-2"
			>
				<SkeletonBlock class="shrink-0 text-xs">Time zone</SkeletonBlock>
				<SkeletonBlock class="h-9 min-w-0 flex-1 rounded-button-lg" />
			</div>
		</div>
	</div>
</div>
