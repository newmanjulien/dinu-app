<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import ArrowUpRightIcon from 'phosphor-svelte/lib/ArrowUpRightIcon';
	import LifebuoyIcon from 'phosphor-svelte/lib/LifebuoyIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import type { SupportContent } from './csm-support';
	import { useCsmDialog } from './csm-dialog.svelte';

	import { useCsmPreload } from './csm-preload.svelte';
	const preload = useCsmPreload();
	const dialog = useCsmDialog();
	let {
		content,
		canStart,
		onReady
	}: {
		content: SupportContent;
		canStart: () => boolean;
		onReady: () => void;
	} = $props();
	let expanded = $state(false);
	let trigger = $state<HTMLButtonElement>();
	let action = $state<HTMLButtonElement>();
	const desktop = new MediaQuery('(min-width: 1000px)', false);

	onMount(() => {
		onReady();
		return dialog.setFocusFallback(restoreFocus);
	});

	function show() {
		if (!canStart()) return;
		dialog.openSupport(action ?? trigger, collapseCard);
	}

	function restoreFocus() {
		const launcher = [action, trigger].find(
			(button) => button?.isConnected && button.getClientRects().length
		);
		if (launcher) launcher.focus({ preventScroll: true });
	}

	async function expand() {
		if (!canStart()) return;
		prepare();
		expanded = true;
		await tick();
		action?.focus({ preventScroll: true });
	}

	function prepare() {
		if (canStart() && !dialog.request) preload.warm('support', { video: content.video });
	}

	function collapseCard() {
		expanded = false;
	}

	async function dismiss() {
		collapseCard();
		await tick();
		trigger?.focus({ preventScroll: true });
	}
</script>

{#snippet widgetIcon(iconClass: string)}
	<span
		class="inline-flex motion-safe:group-hover/action:animate-[lifebuoy-rock_700ms_ease-in-out] motion-safe:group-focus-visible/action:animate-[lifebuoy-rock_700ms_ease-in-out]"
	>
		<LifebuoyIcon class={iconClass} weight="fill" aria-hidden="true" />
	</span>
{/snippet}

<div
	class={`fixed right-3.5 bottom-[calc(20px+var(--buyer-link-bar-height,0px))] z-1 border-edge bg-surface text-ink shadow-floating transition-[background-color,border-color] duration-200 ease-out motion-reduce:transition-none ${expanded && desktop.current ? 'w-[156px] rounded-[9px] border has-[.widget-action:hover]:border-control-border' : 'w-10 rounded-lg border-hairline has-[.widget-action:hover]:bg-surface-hover'}`}
>
	{#if expanded && desktop.current}
		<button
			bind:this={action}
			type="button"
			class="widget-action group/action block w-full cursor-pointer overflow-hidden rounded-[inherit] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
			onclick={() => show()}
			onpointerenter={prepare}
			onfocus={prepare}
			aria-haspopup="dialog"
			aria-label={`${content.headline.join(' ')} — ${content.action.toLowerCase()}`}
		>
			<div class="flex min-h-[105px] flex-col items-start gap-[9px] p-3.5">
				{@render widgetIcon('size-5.5')}
				<span class="font-editorial text-[22px] leading-[1.1] tracking-[-0.035em]">
					{#each content.headline as line}
						<span class="block whitespace-nowrap">{line}</span>
					{/each}
				</span>
			</div>
			<div
				class="flex min-h-10 items-center justify-between gap-[11px] border-t border-line bg-surface px-3.5 py-2.5 text-[13px] leading-[1.3] tracking-[-0.02em] whitespace-nowrap transition-[border-color] duration-200 ease-out group-hover/action:border-control-border motion-reduce:transition-none"
			>
				{content.action}
				<ArrowUpRightIcon
					aria-hidden="true"
					class="size-4 shrink-0 transition-transform duration-200 ease-out motion-safe:group-hover/action:translate-x-0.5 motion-safe:group-hover/action:-translate-y-0.5 motion-reduce:transition-none"
				/>
			</div>
		</button>
		<button
			type="button"
			class="absolute top-2 right-2 grid size-[23px] cursor-pointer place-items-center rounded-full text-ink-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-inherit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-reduce:transition-none"
			aria-label="Dismiss support widget"
			onclick={dismiss}
		>
			<XIcon aria-hidden="true" class="size-3" />
		</button>
	{:else}
		<button
			bind:this={trigger}
			type="button"
			class="widget-action group/action grid h-[38px] w-full cursor-pointer place-items-center overflow-hidden rounded-[inherit] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
			aria-label={desktop.current ? 'Expand support widget' : 'Get support'}
			aria-expanded={desktop.current ? false : undefined}
			aria-haspopup={desktop.current ? undefined : 'dialog'}
			onclick={() => (desktop.current ? expand() : show())}
			onpointerenter={prepare}
			onfocus={prepare}
		>
			{@render widgetIcon('size-[23px]')}
		</button>
	{/if}
</div>

<style>
	@keyframes -global-lifebuoy-rock {
		0%,
		100% {
			transform: rotate(0);
		}
		30% {
			transform: rotate(-18deg);
		}
		65% {
			transform: rotate(12deg);
		}
	}
</style>
