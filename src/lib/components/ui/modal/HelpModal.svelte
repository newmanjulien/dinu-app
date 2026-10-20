<script lang="ts">
	import { onMount } from 'svelte';
	import Checkbox from '$lib/components/ui/Checkbox.svelte';
	import FullHeightModalShell from './FullHeightModalShell.svelte';
	import { helpContent, type HelpVariant } from './help-content';
	import { isHelpHidden, setHelpHidden } from './help-storage';

	let {
		variant,
		isAdmin = false,
		onClose
	}: { variant: HelpVariant; isAdmin?: boolean; onClose: () => void } = $props();
	const content = $derived(helpContent[variant]);

	let hideHelp = $state(false);

	onMount(() => {
		hideHelp = isHelpHidden(variant);
	});

	function handleHideHelpChange(checked: boolean) {
		hideHelp = checked;
		setHelpHidden(variant, checked);
	}
</script>

<FullHeightModalShell title={content.title} {onClose}>
	<div class="flex min-h-full flex-col justify-between gap-6 pt-1">
		<div class="space-y-6">
			<p class="text-[14px] leading-[1.5] text-ink-muted">
				{content.intro}
			</p>

			<div>
				<ol class="m-0 list-none p-0" role="list">
					{#each content.steps as step, index}
						{@const highlight = 'highlight' in step ? step.highlight : undefined}
						{@const highlightStart = highlight ? step.description.indexOf(highlight.text) : -1}
						<li
							class="relative grid grid-cols-[2rem_1fr] gap-x-3 after:absolute after:top-8 after:bottom-0 after:left-[calc(1rem-0.5px)] after:w-px after:bg-line after:content-[''] last:after:hidden"
						>
							<span
								class="z-1 flex size-8 items-center justify-center rounded-full border border-line bg-canvas text-sm leading-none text-ink-muted"
								aria-hidden="true">{index + 1}</span
							>

							<div class:pb-7={index < content.steps.length - 1}>
								<h3 class="text-[14px] leading-tight font-medium text-ink">{step.title}</h3>

								<p class="mt-1.5 text-[14px] leading-[1.6] text-ink-muted">
									{#if highlight && highlightStart >= 0}
										{step.description.slice(0, highlightStart)}<span
											class="rounded-[3px] [box-decoration-break:clone] [-webkit-box-decoration-break:clone]"
											style:background={highlight.color === 'blue'
												? 'var(--document-highlight-selection, var(--color-accent-soft))'
												: 'var(--document-highlight-trigger, color-mix(in srgb, var(--color-success) 16%, transparent))'}
										>
											{highlight.text}
										</span>{step.description.slice(highlightStart + highlight.text.length)}
									{:else}
										{step.description}
									{/if}
									{#if isAdmin && 'adminNote' in step}{' '}{step.adminNote}{/if}
								</p>
							</div>
						</li>
					{/each}
				</ol>

				<Checkbox
					label="Don't show this again"
					checked={hideHelp}
					onCheckedChange={handleHideHelpChange}
					className="mt-6"
				/>
			</div>
		</div>
	</div>
</FullHeightModalShell>
