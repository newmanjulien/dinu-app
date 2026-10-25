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

	// Preserve existing dismissal preferences through the widget rename.
	const DISMISSAL_KEY = 'agreed:admin-book-demo-dismissed';
	const BLUEPRINT_ROLL_CUTOUT = 'M56,48H48A16,16,0,0,0,32,64v84.29A31.82,31.82,0,0,1,48,144h8Z';
	const BLUEPRINT_HASH_CUTOUT =
		'M176,136V120h16a8,8,0,0,0,0-16H176V96a8,8,0,0,0-16,0v8H136V96a8,8,0,0,0-16,0v8H104a8,8,0,0,0,0,16h16v16H104a8,8,0,0,0,0,16h16v8a8,8,0,0,0,16,0v-8h24v8a8,8,0,0,0,16,0v-8h16a8,8,0,0,0,0-16ZM136,120h24v16H136Z';
	const iconId = $props.id();
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

{#snippet blueprintIcon(size: number)}
	<svg
		width={size}
		height={size}
		viewBox="0 0 256 256"
		fill="currentColor"
		aria-hidden="true"
		focusable="false"
	>
		<defs>
			<clipPath id={`${iconId}-hash`}>
				<path clip-rule="evenodd" d={BLUEPRINT_HASH_CUTOUT} />
			</clipPath>
			<linearGradient
				id={`${iconId}-sweep`}
				gradientUnits="userSpaceOnUse"
				x1="-3"
				y1="-3"
				x2="27"
				y2="27"
			>
				<stop offset="0" stop-color="currentColor" stop-opacity="0" />
				<stop offset="0.5" stop-color="currentColor" stop-opacity="0.25" />
				<stop offset="1" stop-color="currentColor" stop-opacity="0" />
			</linearGradient>
		</defs>
		<path
			fill-rule="evenodd"
			d={`M240,64V200a8,8,0,0,1-8,8H48a32,32,0,0,1-32-32V64A32,32,0,0,1,48,32H64a8,8,0,0,1,8,8V56H232A8,8,0,0,1,240,64Z${BLUEPRINT_ROLL_CUTOUT}${BLUEPRINT_HASH_CUTOUT}`}
		/>
		<g clip-path={`url(#${iconId}-hash)`}>
			<polygon
				class="delegation-icon-sweep"
				points="-131,125 125,-131 155,-101 -101,155"
				fill={`url(#${iconId}-sweep)`}
			/>
		</g>
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
					{@render blueprintIcon(22)}
					<span class="font-quote text-[22px] leading-[1.1] tracking-[-0.035em]">
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
				{@render blueprintIcon(23)}
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
		border: 1px solid var(--color-line);
		border-radius: 8px;
		background: var(--color-surface);
		color: var(--color-ink);
		box-shadow:
			0 1px 2px rgb(32 33 36 / 4%),
			0 4px 14px rgb(32 33 36 / 8%);
		transition:
			background-color 200ms ease-out,
			border-color 200ms ease-out,
			box-shadow 200ms ease-out;
	}

	.delegation-widget.expanded {
		width: 160px;
		border-color: #cdced6;
		border-radius: 9px;
		background: #f9f9f9;
		color: #1c2024;
		box-shadow:
			0 2px 3px rgb(28 25 23 / 4%),
			0 8px 18px -8px rgb(28 25 23 / 16%);
	}

	.delegation-widget:has(.delegation-action:hover) {
		background: var(--color-canvas);
	}

	.delegation-widget.expanded:has(.delegation-action:hover) {
		border-color: #60646c;
	}

	.delegation-widget:not(.expanded):has(.delegation-action:hover) {
		box-shadow:
			0 2px 4px rgb(32 33 36 / 5%),
			0 6px 18px rgb(32 33 36 / 10%);
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
		border-top: 1px solid #cdced6;
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
		color: #60646c;
		cursor: pointer;
		transition:
			background-color 150ms ease-out,
			color 150ms ease-out;
	}

	.delegation-close:hover {
		background: #e8e8ec;
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

	.delegation-icon-sweep {
		opacity: 0;
	}

	@keyframes delegation-icon-sweep {
		from {
			opacity: 1;
			transform: translate(72px, 72px);
		}
		to {
			opacity: 1;
			transform: translate(180px, 180px);
		}
	}

	@media (min-width: 1000px) {
		.delegation-widget {
			display: block;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.delegation-widget.expanded:has(.delegation-action:hover) .delegation-icon-sweep {
			animation: delegation-icon-sweep 900ms ease-in-out;
		}

		.delegation-action:hover :global(.delegation-arrow) {
			transform: translate(2px, -2px);
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
