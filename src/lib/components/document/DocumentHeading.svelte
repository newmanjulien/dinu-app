<script lang="ts">
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import QuestionIcon from 'phosphor-svelte/lib/QuestionIcon';
	import { templateCopy } from '$lib/playbook/template-copy';
	import type { TemplateAudience } from '$lib/playbook/model';
	type BuyerPresentation =
		| { kind: 'seller' }
		| { kind: 'preview'; buyerName: string | null }
		| { kind: 'buyer'; companyName: string };

	let {
		kind,
		audience = 'rep',
		buyerPresentation
	}: {
		kind: 'saved' | 'template' | 'buyer';
		audience?: TemplateAudience;
		buyerPresentation?: BuyerPresentation;
	} = $props();
	const copy = $derived.by(() => {
		if (kind === 'template')
			return {
				title: templateCopy(audience).editingTitle,
				hintLabel: templateCopy(audience).editingHelpLabel,
				hint: templateCopy(audience).editingHelp
			};
		if (kind === 'saved')
			return {
				title: 'Negotiate this contract',
				hintLabel: 'About contract negotiation',
				hint: 'Review the instructions and use approved concessions to negotiate this contract.'
			};
		if (buyerPresentation?.kind === 'seller')
			return {
				title: 'Leave and answer comments',
				hintLabel: 'About seller comments',
				hint: 'Leave comments on the contract and reply to buyer comments here.'
			};
		if (buyerPresentation?.kind === 'preview') {
			const buyer = buyerPresentation.buyerName?.trim();
			return {
				title: buyer ? `This is what ${buyer} sees` : 'This is what the buyer sees',
				hintLabel: 'About buyer preview',
				hint: buyer
					? `This preview shows the contract as ${buyer} sees it.`
					: 'This preview shows the contract as the buyer sees it.'
			};
		}
		if (buyerPresentation?.kind === 'buyer')
			return {
				title: `This is your contract with ${buyerPresentation.companyName}`,
				hintLabel: 'About your contract',
				hint: `Review your contract with ${buyerPresentation.companyName} and leave comments here.`
			};
		return null;
	});
</script>

<svelte:element
	this={copy ? 'h1' : 'div'}
	aria-hidden={copy ? undefined : true}
	class={kind === 'buyer'
		? 'mt-2 mb-2 grid min-h-(--mobile-utility-rail-height) place-items-center px-2 text-center text-[13.5px] leading-6 text-ink-muted min-[1000px]:mt-5 min-[1000px]:mb-4 min-[1000px]:min-h-6'
		: 'mb-2 grid min-h-(--mobile-utility-rail-height) place-items-center px-2 pt-2 text-center text-[13.5px] leading-6 text-ink-muted min-[1000px]:mb-4 min-[1000px]:block min-[1000px]:min-h-0 min-[1000px]:pt-5'}
>
	{#if copy}
		<span class="inline-flex max-w-full min-w-0 items-center gap-1.5">
			<span class={kind === 'buyer' ? 'min-w-0 truncate' : ''}>{copy.title}</span>
			<Tooltip label={copy.hintLabel} text={copy.hint}>
				{#snippet children()}
					<QuestionIcon class="size-3.5 shrink-0 text-ink-muted/60" aria-hidden="true" />
				{/snippet}
			</Tooltip>
		</span>
	{/if}
</svelte:element>
