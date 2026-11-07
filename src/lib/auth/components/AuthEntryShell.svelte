<script lang="ts">
	import type { Snippet } from 'svelte';
	import AuthPatternLayer from './AuthPatternLayer.svelte';
	import AuthQuotePanel from './AuthQuotePanel.svelte';
	import type { AuthQuote } from './types';

	type Props = {
		children: Snippet;
		footer?: Snippet;
		showFooter?: boolean;
	};

	let { children, footer, showFooter = Boolean(footer) }: Props = $props();

	const quote = {
		text: 'Dinu cut our sales cycle by 30% and improved rep productivity by 10%.',
		personName: 'Daniel Brooks',
		personTitle: 'CRO, Brex',
		avatarSrc: '/wsp.jpeg',
		avatarAlt: 'Daniel Brooks'
	} satisfies AuthQuote;
</script>

<section
	data-sveltekit-preload-data="off"
	data-sveltekit-preload-code="off"
	class="min-h-dvh bg-page text-ink sm:p-2"
>
	<div
		class="min-h-dvh sm:min-h-[calc(100dvh-16px)] lg:grid lg:grid-cols-[minmax(0,50.2%)_minmax(0,1fr)]"
	>
		<main
			class="box-border flex min-h-dvh flex-col bg-white px-6 pt-12 pb-8 sm:min-h-[calc(100dvh-16px)] sm:rounded-xl sm:border-hairline sm:border-edge lg:px-[clamp(40px,8.55vw,248px)] lg:pt-[clamp(56px,8.6vh,138px)] lg:pb-7"
			aria-label="Dinu account entry"
		>
			<div class="m-auto w-full max-w-[340px]">
				{@render children()}
			</div>

			{#if footer && showFooter}
				<footer class="w-full border-t-(length:--surface-border-width) border-line pt-4">
					{@render footer()}
				</footer>
			{/if}
		</main>

		<aside class="hidden lg:relative lg:block lg:overflow-hidden" aria-label="Customer quote">
			<AuthPatternLayer />
			<AuthQuotePanel {quote} />
		</aside>
	</div>
</section>
