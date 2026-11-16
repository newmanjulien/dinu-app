<script lang="ts">
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import QuestionIcon from 'phosphor-svelte/lib/QuestionIcon';
	import { templateCopy } from '$lib/playbook/template-copy';
	import type { TemplateAudience } from '$lib/playbook/model';

	let {
		kind,
		audience = 'rep'
	}: {
		kind: 'saved' | 'template' | 'buyer';
		audience?: TemplateAudience;
	} = $props();
	const copy = $derived(
		kind === 'template'
			? {
					title: templateCopy(audience).editingTitle,
					hintLabel: templateCopy(audience).editingHelpLabel,
					hint: templateCopy(audience).editingHelp
				}
			: kind === 'buyer'
				? {
						title: 'Review this contract',
						hintLabel: 'About this contract',
						hint: 'Buyers can read the contract and leave comments here.'
					}
				: {
						title: 'Negotiate this contract',
						hintLabel: 'About contract negotiation',
						hint: 'Review the instructions and use approved concessions to negotiate this contract.'
					}
	);
</script>

<h1
	class={kind === 'buyer'
		? 'mt-2 mb-2 grid min-h-(--mobile-utility-rail-height) place-items-center px-2 text-center text-[13.5px] leading-6 text-ink-muted min-[1000px]:mt-5 min-[1000px]:mb-4 min-[1000px]:min-h-6'
		: 'mb-2 grid min-h-(--mobile-utility-rail-height) place-items-center px-2 pt-2 text-center text-[13.5px] leading-6 text-ink-muted min-[1000px]:mb-4 min-[1000px]:block min-[1000px]:min-h-0 min-[1000px]:pt-5'}
>
	<span class="inline-flex items-center gap-1.5">
		<span>{copy.title}</span>
		<Tooltip label={copy.hintLabel} text={copy.hint}>
			{#snippet children()}
				<QuestionIcon class="size-3.5 text-ink-muted/60" aria-hidden="true" />
			{/snippet}
		</Tooltip>
	</span>
</h1>
