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
		text: 'Overbase increased partnership revenue by 20% in the divisions we deployed it to',
		personName: "Alexandre L'Heureux",
		personTitle: 'CEO at WSP',
		avatarSrc: '/wsp.jpeg',
		avatarAlt: "Alexandre L'Heureux"
	} satisfies AuthQuote;
</script>

<section data-sveltekit-preload-data="off" data-sveltekit-preload-code="off" class="entry-shell">
	<div class="entry-layout">
		<main class="entry-panel" aria-label="Agreed account entry">
			<div class="entry-content">
				{@render children()}
			</div>

			{#if footer && showFooter}
				<footer class="entry-footer">
					{@render footer()}
				</footer>
			{/if}
		</main>

		<aside class="entry-testimonial" aria-label="Customer quote">
			<AuthPatternLayer />
			<AuthQuotePanel {quote} />
		</aside>
	</div>
</section>

<style>
	.entry-shell {
		min-height: 100dvh;
		background: var(--color-page);
		color: #202124;
	}

	.entry-layout {
		min-height: 100dvh;
	}

	.entry-panel {
		box-sizing: border-box;
		display: flex;
		min-height: 100dvh;
		flex-direction: column;
		padding: 48px 24px 32px;
		background: white;
	}

	.entry-content {
		width: 100%;
		max-width: 340px;
		margin: auto;
	}

	.entry-footer {
		width: 100%;
		border-top: 1px solid #eceef1;
		padding-top: 16px;
	}

	.entry-testimonial {
		display: none;
	}

	@media (min-width: 640px) {
		.entry-shell {
			padding: 8px;
		}

		.entry-layout,
		.entry-panel {
			min-height: calc(100dvh - 16px);
		}

		.entry-panel {
			border: 1px solid rgb(0 0 0 / 4%);
			border-radius: 12px;
		}
	}

	@media (min-width: 1024px) {
		.entry-layout {
			display: grid;
			grid-template-columns: minmax(0, 50.2%) minmax(0, 1fr);
		}

		.entry-panel {
			padding: clamp(56px, 8.6vh, 138px) clamp(40px, 8.55vw, 248px) 28px;
		}

		.entry-testimonial {
			position: relative;
			display: block;
			overflow: hidden;
		}
	}
</style>
