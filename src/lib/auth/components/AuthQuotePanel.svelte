<script lang="ts">
	import type { AuthQuote } from './types';

	type Props = {
		quote: AuthQuote;
	};

	let { quote }: Props = $props();
</script>

<svg
	aria-hidden="true"
	class="absolute inset-0 size-full text-[#d1d5db] opacity-[0.14] [stroke-width:1.2]"
	viewBox="0 0 1200 1200"
	preserveAspectRatio="none"
>
	<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
		<path d="M170 0Q360 160 360 230V970Q360 1040 170 1200" />
		<path d="M0 330L150 600L0 870" />
		<path d="M1030 0Q840 160 840 230V970Q840 1040 1030 1200" />
		<path d="M1200 330L1050 600L1200 870" />
		<rect x="440" y="0" width="320" height="1200" rx="110" />
	</g>
</svg>

<div
	class="relative z-[1] flex h-full min-h-[calc(100dvh-16px)] flex-col items-center justify-center px-[clamp(72px,7.8vw,224px)] text-center"
>
	<div
		aria-hidden="true"
		class="absolute -z-10 h-[260px] w-[min(1040px,118%)] rounded-full bg-gray-200/60 blur-[42px]"
	></div>

	<blockquote
		class="font-quote m-0 max-w-[560px] text-[clamp(25px,1.4vw,38px)] font-medium leading-[1.16] tracking-normal text-[#1c1917]"
	>
		"{quote.text}"
	</blockquote>

	<div class="mt-10 inline-flex items-center gap-3.5 text-left">
		<div
			class="relative size-14 shrink-0 overflow-hidden rounded-full bg-gray-100 shadow-[0_0_0_1px_rgb(0_0_0_/_10%)]"
		>
			<img
				src={quote.avatarSrc}
				alt={quote.avatarAlt}
				class="size-full rounded-full object-cover"
			/>
		</div>
		<div>
			<p class="m-0 text-sm font-medium leading-[1.18] text-[#202124]">{quote.personName}</p>
			<p class="mt-1 mb-0 text-sm leading-[1.18] text-[#8c8f94]">
				{quote.personTitle}
			</p>
		</div>
	</div>
</div>
