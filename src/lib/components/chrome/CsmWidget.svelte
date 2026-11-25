<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { page } from '$app/state';
	import { useConvexClient } from 'convex-svelte';
	import ArrowUpRightIcon from 'phosphor-svelte/lib/ArrowUpRightIcon';
	import LifebuoyIcon from 'phosphor-svelte/lib/LifebuoyIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import VideoFacade from '$lib/ui/VideoFacade.svelte';
	import { useVideoPreconnect, warmVideoPoster } from '$lib/ui/video.svelte';
	import type { AvailabilitySelection } from './csm-availability';
	import { loadCsmModal } from './csm-modal';
	import { createCsmOwner, initialAvailability } from './csm-owner.svelte';
	import { supportContent, type SupportContent, type SupportSection } from './csm-support';
	import CsmBookingSkeleton from './CsmBookingSkeleton.svelte';

	type SupportDialog = {
		path: string;
		section: SupportSection;
		initial: AvailabilitySelection;
		content: SupportContent;
		trigger?: HTMLButtonElement;
	};

	const client = useConvexClient();
	const videoPreconnect = useVideoPreconnect();
	let {
		membershipId,
		section,
		setupComplete,
		collapsed,
		onCollapsedChange,
		canStart
	}: {
		membershipId: Id<'memberships'>;
		section: SupportSection | undefined;
		setupComplete: boolean;
		collapsed: boolean;
		onCollapsedChange: (collapsed: boolean) => Promise<unknown>;
		canStart: () => boolean;
	} = $props();

	let alive = true;
	const current = () => alive;
	const owner = createCsmOwner({
		client,
		membershipId: untrack(() => membershipId),
		current,
		canRead: (mode, replacement) => current() && mode === 'support' && !replacement
	});
	onDestroy(() => {
		alive = false;
		owner.dispose();
	});

	const content = $derived(
		section ? supportContent({ section, complete: setupComplete }) : undefined
	);
	let shown = $state(false);
	$effect(() => {
		if (!section) shown = false;
		else if (canStart()) shown = true;
	});
	const visible = $derived(Boolean(content && (shown || canStart())));

	// The member's saved choice, overridden locally until their latest change is saved.
	let override = $state<boolean>();
	let saving = $state(0);
	let latest = 0;
	const expanded = $derived(!(override ?? collapsed));
	let trigger = $state<HTMLButtonElement>();
	let action = $state<HTMLButtonElement>();
	const desktop = new MediaQuery('(min-width: 1000px)', false);

	$effect(() => {
		if (!saving && override === collapsed) override = undefined;
	});

	let activeDialog = $state.raw<SupportDialog>();
	let admitted = $state.raw<SupportDialog>();
	let completed = $state.raw<SupportDialog>();
	let inProgress = $state(false);
	const currentDialog = $derived(
		activeDialog &&
			owner.availability.current() &&
			activeDialog.path === page.url.pathname &&
			activeDialog.section === section
			? activeDialog
			: undefined
	);
	const modalOpen = $derived(Boolean(currentDialog && (admitted === currentDialog || canStart())));
	$effect(() => {
		if (!currentDialog) {
			activeDialog = undefined;
			admitted = undefined;
			completed = undefined;
			inProgress = false;
		}
	});
	const body = loadComponent(
		loadCsmModal,
		() => Boolean(currentDialog && admitted === currentDialog && canStart()),
		() => activeDialog
	);
	const BookingBody = $derived(body.component);

	async function persist(next: boolean) {
		override = next;
		const write = ++latest;
		saving++;
		try {
			await onCollapsedChange(next);
		} catch {
			if (write === latest) override = undefined;
		} finally {
			saving--;
		}
	}

	function warm(selection: AvailabilitySelection = initialAvailability('support')) {
		try {
			if (!canStart() || !owner.canRead(selection.mode, selection.replacement)) return false;
			void loadCsmModal().catch(() => {});
			if (!owner.unresolved) void owner.availability.read(selection).catch(() => {});
			return true;
		} catch {
			/* Optional work cannot interrupt focus or navigation. */
			return false;
		}
	}

	function prepare() {
		if (!canStart() || activeDialog || !content) return;
		if (!warm()) return;
		if (content.video) {
			warmVideoPoster(content.video.poster, 'high');
			videoPreconnect?.prepare();
		}
	}

	function show() {
		if (activeDialog || !section || !content || !canStart() || !owner.canRead('support')) return;
		activeDialog = {
			path: page.url.pathname,
			section,
			initial: initialAvailability('support'),
			content,
			trigger: action ?? trigger
		};
	}

	async function closeDialog(closing: SupportDialog) {
		if (activeDialog !== closing) return;
		activeDialog = undefined;
		await tick();
		if (activeDialog) return;
		const target = [closing.trigger, action, trigger].find(
			(button) => button?.isConnected && !button.disabled && button.getClientRects().length
		);
		target?.focus({ preventScroll: true });
	}

	async function expand() {
		if (!canStart()) return;
		prepare();
		void persist(false);
		await tick();
		action?.focus({ preventScroll: true });
	}

	async function dismiss() {
		void persist(true);
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

{#if visible && content}
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
{/if}

{#if currentDialog && modalOpen}
	<ModalShell
		open={modalOpen}
		title="Get support"
		variant="panel"
		position="right"
		class="max-w-[600px]"
		onOpen={() => {
			if (!currentDialog) return;
			admitted = currentDialog;
			warm(currentDialog.initial);
			if (currentDialog.content.video) videoPreconnect?.prepare();
		}}
		onClose={() => currentDialog && closeDialog(currentDialog)}
	>
		{#if currentDialog.content.video && !inProgress && completed !== currentDialog}
			<VideoFacade video={currentDialog.content.video} />
		{/if}
		{#key currentDialog}
			{#if BookingBody && admitted === currentDialog}
				<BookingBody
					bind:inProgress
					{owner}
					initial={currentDialog.initial}
					content={currentDialog.content}
					onBooked={() => (completed = currentDialog)}
					onClose={() => closeDialog(currentDialog)}
				/>
			{:else if body.failed}
				<p role="status" class="text-[12.5px] leading-relaxed text-ink-muted">
					Booking is temporarily unavailable. <button class="underline" onclick={() => body.retry()}
						>Try again</button
					>
				</p>
			{:else}
				<CsmBookingSkeleton
					description={currentDialog.content.scheduling}
					timeZone={currentDialog.initial.timeZone}
					flushTop={!currentDialog.content.video}
				/>
			{/if}
		{/key}
	</ModalShell>
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
</style>
