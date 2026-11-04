<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { resolveAvatarUrl } from '$lib/avatar';
	import type { Catalog } from '../../../convex/delegationValidators';
	import { useQuery } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import ArrowUpRightIcon from 'phosphor-svelte/lib/ArrowUpRightIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import { loadComponent } from '$lib/auth/component-loader.svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import LoadingWheel from '$lib/ui/LoadingWheel.svelte';

	const DISMISSAL_KEY = 'dinu:admin-book-demo-dismissed';
	const iconMaskId = $props.id();
	let expanded = $state<boolean | null>(null);
	let trigger = $state<HTMLButtonElement>();
	let action = $state<HTMLButtonElement>();
	let modalOpen = $state(false);
	const desktop = new MediaQuery('(min-width: 1000px)', false);
	const viewer = useViewer();
	const session = useViewerSession();
	const modal = loadComponent(
		() => import('$lib/components/ui/modal/DelegateTaskModal.svelte'),
		() => modalOpen,
		() => session.transportGeneration
	);
	const DelegateTaskModal = $derived(modal.component);
	const membershipId = viewer().membership.id;
	let refreshToken = $state('');
	let rejectedCatalog = $state.raw<Catalog | undefined>();
	let observedCatalog: Catalog | null | undefined;
	const catalogEnabled = $derived(
		!session.closing && expanded !== null && (desktop.current || modalOpen)
	);
	const catalogArgs = $derived(catalogEnabled ? { membershipId, refreshToken } : 'skip');
	const catalogQuery = useQuery(api.delegation.getCatalog, () => catalogArgs);
	const catalogData = $derived(
		rejectedCatalog && (!catalogQuery.data || rejectedCatalog.revision > catalogQuery.data.revision)
			? rejectedCatalog
			: catalogQuery.data
	);
	const avatarSrc = $derived(resolveAvatarUrl(catalogData?.delegate.avatarPath));
	function reconcileCatalog(snapshot: Catalog | null) {
		if (snapshot) {
			observedCatalog = catalogQuery.data;
			rejectedCatalog = snapshot;
		} else {
			rejectedCatalog = undefined;
			refreshToken = crypto.randomUUID();
		}
	}
	$effect(() => {
		const live = catalogQuery.data;
		untrack(() => {
			if (
				rejectedCatalog &&
				live !== observedCatalog &&
				(live === null || (live && live.revision >= rejectedCatalog.revision))
			)
				rejectedCatalog = undefined;
		});
	});
	$effect(() => {
		if (!avatarSrc) return;
		const avatar = new Image();
		avatar.src = avatarSrc;
		void avatar.decode().catch(() => {});
	});

	onMount(() => {
		try {
			expanded = localStorage.getItem(DISMISSAL_KEY) !== 'true';
		} catch {
			expanded = true;
		}
	});

	function show() {
		if (catalogQuery.error || catalogData === null) {
			rejectedCatalog = undefined;
			refreshToken = crypto.randomUUID();
		}
		modalOpen = true;
	}
	async function closeModal() {
		modalOpen = false;
		await tick();
		(expanded ? action : trigger)?.focus({ preventScroll: true });
	}

	async function expand() {
		expanded = true;
		try {
			localStorage.removeItem(DISMISSAL_KEY);
		} catch {
			// Keep the current view expanded when browser storage is unavailable.
		}
		await tick();
		action?.focus({ preventScroll: true });
	}

	async function dismiss() {
		expanded = false;
		try {
			localStorage.setItem(DISMISSAL_KEY, 'true');
		} catch {
			// Keep the current view collapsed when browser storage is unavailable.
		}
		await tick();
		trigger?.focus({ preventScroll: true });
	}
</script>

{#snippet delegationIcon(size: number)}
	<svg
		xmlns="http://www.w3.org/2000/svg"
		width={size}
		height={size}
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
						class="delegation-check"
						d="M117.66,85.66l-32,32a8,8,0,0,1-11.32,0l-16-16A8,8,0,0,1,69.66,90.34L80,100.69l26.34-26.35a8,8,0,0,1,11.32,11.32Z"
					/>
					<path
						class="delegation-check delegation-check-second"
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

{#if expanded !== null}
	<div class="delegation-widget" class:expanded>
		{#if expanded}
			<button
				bind:this={action}
				type="button"
				class="delegation-action"
				onclick={show}
				aria-haspopup="dialog"
				aria-label="We'll take care of it — delegate"
			>
				<div class="flex min-h-[110px] flex-col items-start gap-[10px] p-4">
					{@render delegationIcon(22)}
					<span class="font-editorial text-[22px] leading-[1.1] tracking-[-0.035em]">
						We'll take care of it
					</span>
				</div>
				<div
					class="delegation-row flex min-h-[44px] items-center justify-between gap-3 px-4 py-3 text-[13px] leading-[1.3] tracking-[-0.02em]"
				>
					Delegate a task
					<ArrowUpRightIcon aria-hidden="true" size={16} class="delegation-arrow" />
				</div>
			</button>
			<button
				type="button"
				class="delegation-close"
				aria-label="Dismiss delegation widget"
				onclick={dismiss}
			>
				<XIcon aria-hidden="true" size={12} />
			</button>
		{:else}
			<button
				bind:this={trigger}
				type="button"
				class="delegation-action delegation-trigger"
				aria-label="Expand delegation widget"
				aria-expanded="false"
				onclick={expand}
			>
				{@render delegationIcon(23)}
			</button>
		{/if}
	</div>
{/if}

{#if modalOpen}
	{#if DelegateTaskModal}<DelegateTaskModal
			onClose={closeModal}
			{catalogData}
			onCatalogRejected={reconcileCatalog}
			catalogError={catalogQuery.error}
		/>{:else}<ModalShell onClose={closeModal} title="Delegate a task">
			{#if modal.failed}
				<p role="alert" class="text-sm">We couldn’t open delegation.</p>
				<button class="mt-3 text-sm underline" onclick={modal.retry}>Try again</button>
			{:else}<LoadingWheel label="Opening delegation" />{/if}
		</ModalShell>{/if}
{/if}

<style>
	.delegation-widget {
		display: none;
		position: fixed;
		right: 14px;
		bottom: 20px;
		z-index: 1;
		width: 44px;
		border: var(--surface-border-width) solid var(--color-edge);
		border-radius: 8px;
		background: var(--color-surface);
		color: var(--color-ink);
		box-shadow: var(--shadow-floating);
		transition: background-color 200ms ease-out;
	}

	.delegation-widget.expanded {
		width: 160px;
		border-radius: 9px;
	}

	.delegation-widget:has(.delegation-action:hover) {
		background: var(--color-surface-hover);
	}

	.delegation-action {
		text-align: left;
		display: block;
		overflow: hidden;
		width: 100%;
		border-radius: inherit;
		cursor: pointer;
	}

	.delegation-trigger {
		display: grid;
		place-items: center;
		height: 42px;
	}

	.delegation-row {
		border-top: var(--surface-border-width) solid var(--color-line);
		background: var(--color-surface);
	}

	.delegation-close {
		position: absolute;
		top: 8px;
		right: 8px;
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: 50%;
		color: var(--color-ink-muted);
		cursor: pointer;
		transition:
			background-color 150ms ease-out,
			color 150ms ease-out;
	}

	.delegation-close:hover {
		background: var(--color-surface-hover);
		color: inherit;
	}

	.delegation-action:focus-visible,
	.delegation-close:focus-visible {
		outline: 2px solid var(--color-ink);
		outline-offset: 2px;
	}

	.delegation-action :global(.delegation-arrow) {
		flex-shrink: 0;
		transition: transform 200ms ease-out;
	}

	@media (min-width: 1000px) {
		.delegation-widget {
			display: block;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.delegation-widget.expanded:hover .delegation-check {
			animation: check-off 400ms ease-out backwards;
		}

		.delegation-widget.expanded:hover .delegation-check-second {
			animation-delay: 160ms;
		}

		.delegation-action:hover :global(.delegation-arrow) {
			transform: translate(2px, -2px);
		}
	}

	@keyframes check-off {
		from {
			clip-path: inset(0 100% 0 0) fill-box;
		}
		to {
			clip-path: inset(0) fill-box;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.delegation-widget,
		.delegation-close,
		.delegation-action :global(.delegation-arrow) {
			transition: none;
		}
	}
</style>
