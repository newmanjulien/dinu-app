<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import ArrowUpRightIcon from 'phosphor-svelte/lib/ArrowUpRightIcon';
	import LifebuoyIcon from 'phosphor-svelte/lib/LifebuoyIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import type { CsmBookingMode } from './csm-booking';
	import { useCsmDialog } from './csm-dialog.svelte';

	import { useCsmPreload } from './csm-preload.svelte';
	const preload = useCsmPreload();
	const dialog = useCsmDialog();
	let {
		mode,
		canStart,
		onReady
	}: {
		mode: CsmBookingMode;
		canStart: () => boolean;
		onReady: () => void;
	} = $props();
	const DISMISSAL_KEY = 'dinu:csm-widget-dismissed';
	const iconMaskId = $props.id();
	let expanded = $state<boolean | null>(null);
	let trigger = $state<HTMLButtonElement>();
	let action = $state<HTMLButtonElement>();
	let onboardingState: App.PageState | undefined;
	const desktop = new MediaQuery('(min-width: 1000px)', false);

	onMount(() => {
		onReady();
		const releaseFocus = dialog.setFocusFallback(restoreFocus);
		let mounted = true;
		// Preloading starts the download early; wait for decoding before painting the headline.
		void (
			document.fonts?.load('22px Newsreader', "We'll take care of it We're here to help") ??
			Promise.resolve()
		)
			.catch(() => {
				// Keep the widget available with the fallback font if the download fails.
			})
			.then(() => {
				if (!mounted) return;
				try {
					expanded = localStorage.getItem(DISMISSAL_KEY) !== 'true';
				} catch {
					expanded = true;
				}
			});
		return () => {
			mounted = false;
			releaseFocus();
		};
	});

	$effect(() => {
		const state = page.state;
		if (
			expanded === null ||
			page.route.id !== '/(workspace)/admin' ||
			!state.showDelegationOnboarding
		)
			return;
		if (!canStart() || dialog.request) return;
		untrack(() => {
			if (onboardingState === state) return;
			onboardingState = state;
			if (mode === 'support') {
				consumeOnboarding(state);
				return;
			}
			showCard();
			show(state);
		});
	});

	function consumeOnboarding(handoff: App.PageState | undefined) {
		// Consume only this visit's handoff, after opening or when a booking suppresses it.
		if (page.state !== handoff || !page.state.showDelegationOnboarding) return;
		const state = { ...page.state };
		delete state.showDelegationOnboarding;
		replaceState(page.url, state);
	}

	function show(handoff?: App.PageState) {
		dialog.open(mode, action ?? trigger, {
			onOpen: () => consumeOnboarding(handoff),
			onBooked: collapseCard
		});
	}

	function restoreFocus() {
		const launcher = [action, trigger].find(
			(button) => button?.isConnected && button.getClientRects().length
		);
		if (launcher) launcher.focus({ preventScroll: true });
	}

	function showCard() {
		expanded = true;
		try {
			localStorage.removeItem(DISMISSAL_KEY);
		} catch {
			// Keep the current view expanded when browser storage is unavailable.
		}
	}

	async function expand() {
		preload.warm(mode);
		showCard();
		await tick();
		action?.focus({ preventScroll: true });
	}

	function collapseCard() {
		expanded = false;
		try {
			localStorage.setItem(DISMISSAL_KEY, 'true');
		} catch {
			// Keep the current view collapsed when browser storage is unavailable.
		}
	}

	async function dismiss() {
		collapseCard();
		await tick();
		trigger?.focus({ preventScroll: true });
	}
</script>

{#snippet delegationIcon(iconClass: string)}
	<svg
		xmlns="http://www.w3.org/2000/svg"
		class={iconClass}
		viewBox="0 0 256 256"
		fill="currentColor"
		aria-hidden="true"
		focusable="false"
	>
		<defs>
			<mask id={iconMaskId} maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256">
				<rect width="256" height="256" fill="white" />
				<g fill="black">
					<path
						d="M192,168H144a8,8,0,0,1,0-16h48a8,8,0,0,1,0,16Zm0-64H144a8,8,0,0,1,0-16h48a8,8,0,0,1,0,16Z"
					/>
					<path
						class="motion-safe:group-hover/action:animate-[check-off_400ms_ease-out_backwards] motion-safe:group-focus-visible/action:animate-[check-off_400ms_ease-out_backwards]"
						d="M117.66,85.66l-32,32a8,8,0,0,1-11.32,0l-16-16A8,8,0,0,1,69.66,90.34L80,100.69l26.34-26.35a8,8,0,0,1,11.32,11.32Z"
					/>
					<path
						class="motion-safe:group-hover/action:animate-[check-off_400ms_ease-out_backwards] motion-safe:group-focus-visible/action:animate-[check-off_400ms_ease-out_backwards] [animation-delay:160ms]"
						d="M117.66,149.66l-32,32a8,8,0,0,1-11.32,0l-16-16a8,8,0,0,1,11.32-11.32L80,164.69l26.34-26.35a8,8,0,0,1,11.32,11.32Z"
					/>
				</g>
			</mask>
		</defs>
		<path
			mask={`url(#${iconMaskId})`}
			d="M208,32H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32Z"
		/>
	</svg>
{/snippet}

{#snippet widgetIcon(iconClass: string)}
	{#if mode === 'setup'}
		{@render delegationIcon(iconClass)}
	{:else}
		<span
			class="inline-flex motion-safe:group-hover/action:animate-[lifebuoy-rock_700ms_ease-in-out] motion-safe:group-focus-visible/action:animate-[lifebuoy-rock_700ms_ease-in-out]"
		>
			<LifebuoyIcon class={iconClass} weight="fill" aria-hidden="true" />
		</span>
	{/if}
{/snippet}

{#if expanded !== null}
	<div
		class={`fixed right-3.5 bottom-5 z-1 border-hairline border-edge bg-surface text-ink shadow-floating transition-[background-color,border-color] duration-200 ease-out motion-reduce:transition-none ${expanded && desktop.current ? 'w-40 rounded-[9px] has-[.widget-action:hover]:border-control-border' : 'w-11 rounded-lg has-[.widget-action:hover]:bg-surface-hover'}`}
	>
		{#if expanded && desktop.current}
			<button
				bind:this={action}
				type="button"
				class="widget-action group/action block w-full cursor-pointer overflow-hidden rounded-[inherit] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
				onclick={() => show()}
				aria-haspopup="dialog"
				aria-label={mode === 'setup'
					? "We'll take care of it — delegate"
					: "We're here to help — get support"}
			>
				<div class="flex min-h-[110px] flex-col items-start gap-[10px] p-4">
					{@render widgetIcon('size-5.5')}
					<span class="font-editorial text-[22px] leading-[1.1] tracking-[-0.035em]">
						{mode === 'setup' ? "We'll take care of it" : "We're here to help"}
					</span>
				</div>
				<div
					class="border-t-(length:--surface-border-width) border-line bg-surface flex min-h-[44px] items-center justify-between gap-3 px-4 py-3 text-[13px] leading-[1.3] tracking-[-0.02em] transition-[border-color] duration-200 ease-out group-hover/action:border-control-border motion-reduce:transition-none"
				>
					{mode === 'setup' ? 'Delegate setup' : 'Get support'}
					<ArrowUpRightIcon
						aria-hidden="true"
						class="size-4 shrink-0 transition-transform duration-200 ease-out motion-safe:group-hover/action:translate-x-0.5 motion-safe:group-hover/action:-translate-y-0.5 motion-reduce:transition-none"
					/>
				</div>
			</button>
			<button
				type="button"
				class="absolute top-2 right-2 grid size-6 cursor-pointer place-items-center rounded-full text-ink-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-inherit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink motion-reduce:transition-none"
				aria-label={mode === 'setup' ? 'Dismiss delegation widget' : 'Dismiss support widget'}
				onclick={dismiss}
			>
				<XIcon aria-hidden="true" class="size-3" />
			</button>
		{:else}
			<button
				bind:this={trigger}
				type="button"
				class="widget-action group/action grid h-10.5 w-full cursor-pointer place-items-center overflow-hidden rounded-[inherit] text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
				aria-label={desktop.current
					? mode === 'setup'
						? 'Expand delegation widget'
						: 'Expand support widget'
					: mode === 'setup'
						? 'Delegate a task'
						: 'Get support'}
				aria-expanded={desktop.current ? false : undefined}
				aria-haspopup={desktop.current ? undefined : 'dialog'}
				onclick={() => (desktop.current ? expand() : show())}
			>
				{@render widgetIcon('size-[23px]')}
			</button>
		{/if}
	</div>
{/if}

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

	@keyframes -global-check-off {
		from {
			clip-path: inset(0 100% 0 0) fill-box;
		}
		to {
			clip-path: inset(0) fill-box;
		}
	}
</style>
