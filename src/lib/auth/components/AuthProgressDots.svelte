<script lang="ts">
	let { step }: { step: 1 | 2 | 3 } = $props();
	const stages = ['Your email', 'Verify email', 'Your company'];
</script>

<ol
	aria-label="Sign-up progress"
	class="absolute top-1/2 left-3 m-0 hidden -translate-y-1/2 list-none flex-col items-center gap-2 p-0 md:flex"
>
	{#each stages as label, index (label)}
		<li aria-current={index + 1 === step ? 'step' : undefined}>
			<span class="sr-only">
				Step {index + 1} of {stages.length}: {label}{index + 1 < step
					? ', completed'
					: index + 1 === step
						? ', current step'
						: ''}
			</span>
			{#if index + 1 === step}
				<span
					aria-hidden="true"
					class="block size-[11px] rounded-full border-4 border-accent bg-white"
				></span>
			{:else if index + 1 < step}
				<span
					aria-hidden="true"
					class="flex size-[11px] items-center justify-center rounded-full bg-ink/8"
				>
					<span class="size-0.75 rounded-full bg-ink-muted/50"></span>
				</span>
			{:else}
				<span
					aria-hidden="true"
					class="flex size-[11px] items-center justify-center rounded-full border border-edge/50 bg-white"
				>
					<span class="size-0.75 rounded-full bg-ink-muted/25"></span>
				</span>
			{/if}
		</li>
	{/each}
</ol>
