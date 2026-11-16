<script lang="ts">
	import { untrack } from 'svelte';
	import type { FunctionReturnType } from 'convex/server';
	import { useConvexClient } from 'convex-svelte';
	import { waitForRead } from '$lib/auth/attempt';
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import FloatingSurface from '$lib/components/ui/FloatingSurface.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	import type { CloseReason } from '$lib/components/ui/interactions';
	import { api } from '../../convex/_generated/api';
	import type { Id } from '../../convex/_generated/dataModel';

	let { id }: { id: Id<'savedContracts'> } = $props();
	const viewer = useViewer();
	const panelId = $props.id();
	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();
	const client = useConvexClient();
	const scope = $derived(
		JSON.stringify([viewer().profile.id, viewer().membership.id, viewer().company.id, id])
	);
	let data = $state.raw<{
		scope: string;
		rows: FunctionReturnType<typeof api.buyerActivity.recent>;
	}>();
	let error = $state(false);
	let refresh = $state(0);
	const rows = $derived(
		data?.scope === scope ? data.rows.filter((row) => row.expiresAt > now) : undefined
	);
	$effect(() => {
		const key = scope;
		untrack(() => {
			if (data?.scope !== key) data = undefined;
		});
		if (!open) return;
		error = false;
		const args = { membershipId: viewer().membership.id, id };
		void refresh;
		let cancelled = false;
		let request = 0;
		let timer: ReturnType<typeof setTimeout>;
		async function load() {
			const currentRequest = ++request;
			const current = () => !cancelled && currentRequest === request;
			try {
				// A delivered refusal clears history; only a local deadline may retain it.
				const response = client.mutation(api.buyerActivity.recent, args).catch((cause) => {
					if (current()) data = undefined;
					throw cause;
				});
				const result = await waitForRead(response, AbortSignal.timeout(15_000));
				if (current()) {
					data = { scope: key, rows: result };
					error = false;
				}
			} catch {
				if (current()) error = true;
			}
			if (!cancelled) timer = setTimeout(load, 30_000);
		}
		void load();
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	});
	let now = $state(Date.now());
	let list = $state<HTMLUListElement>();
	let listHeight = $state<number>();

	$effect(() => {
		rows;
		if (!open || !list) {
			listHeight = undefined;
			return;
		}
		const element = list;
		const visibleRows = Array.from(element.children).slice(0, 5);
		const measure = () => {
			listHeight = visibleRows.reduce(
				(height, row) => height + row.getBoundingClientRect().height,
				0
			);
		};
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		for (const row of visibleRows) observer.observe(row);
		measure();
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!open) return;
		now = Date.now();
		const clock = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(clock);
	});

	function close(reason: CloseReason) {
		open = false;
		if (reason === 'escape') trigger?.focus({ preventScroll: true });
	}
	function relativeTime(at: number) {
		const seconds = Math.max(0, Math.floor((now - at) / 1000));
		if (seconds < 60) return 'Just now';
		if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
		if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
		return `${Math.floor(seconds / 86_400)}d ago`;
	}
	function description(row: FunctionReturnType<typeof api.buyerActivity.recent>[number]) {
		const person = `Visitor ${row.visitorNumber}${row.city ? ` in ${row.city}` : ''}`;
		const action =
			row.type === 'clause_opened'
				? row.clauseCount === 1
					? 'clicked on a clause'
					: `clicked on ${row.clauseCount} clauses`
				: row.returning
					? 'returned to the link'
					: 'opened the link';
		return `${person} ${action}`;
	}
</script>

<Tooltip text="See recent activity" {trigger} standalone={false} enabled={!open}>
	{#snippet children(descriptionId)}
		<button
			bind:this={trigger}
			type="button"
			class="-ml-0.5 inline-flex h-[18px] w-4 shrink-0 cursor-pointer items-center justify-center rounded-md border-0 bg-transparent text-ink-secondary transition-colors hover:bg-field-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-expanded:bg-field-hover aria-expanded:text-ink"
			aria-label="See recent activity"
			aria-describedby={descriptionId}
			aria-expanded={open}
			aria-controls={panelId}
			onclick={() => {
				now = Date.now();
				open = !open;
			}}
		>
			<svg
				class="size-3.5"
				viewBox="0 0 16 16"
				fill="none"
				stroke="currentColor"
				stroke-width="1.1"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="m5 6 3-3 3 3M5 10l3 3 3-3" />
			</svg>
		</button>
	{/snippet}
</Tooltip>
<FloatingSurface
	{open}
	{trigger}
	onClose={close}
	placement="right-start"
	gap={4}
	id={panelId}
	role="group"
	label="Recent activity"
	dismissOnFocus
	class="w-[390px] rounded-xl border-hairline border-edge bg-surface py-[3px] text-ink shadow-card"
>
	<h3 class="px-3 py-[7px] text-xs font-normal text-ink-muted/70">Recent activity</h3>
	{#if error}
		<p role="alert" class="px-3 py-[7px] text-xs text-ink-muted">
			Couldn’t load activity.
			<button
				type="button"
				class="cursor-pointer rounded-sm text-ink underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
				onclick={() => refresh++}>Try again</button
			>
		</p>
	{/if}
	{#if rows?.length === 0 && !error}
		<p class="px-3 py-[7px] text-xs text-ink-muted">No recorded activity.</p>
	{:else if rows?.length}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard users need to reach the scrollable history.) -->
		<ul
			bind:this={list}
			tabindex={rows.length > 5 ? 0 : undefined}
			aria-label="Recent activity entries"
			class="overflow-y-auto overscroll-contain"
			style:max-height={listHeight === undefined ? undefined : `${listHeight}px`}
		>
			{#each rows as row (row.id)}
				<li class="flex items-center justify-between gap-3 px-3 py-[7px]">
					<div class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs leading-4">
						<span class="min-w-0 break-words">{description(row)}</span>
						{#if row.actor}
							<span
								class="shrink-0 rounded bg-surface-hover px-1.5 py-0.5 text-[10px] leading-3 text-ink-muted"
							>
								{row.actor}
							</span>
						{/if}
					</div>
					<time
						datetime={new Date(row.at).toISOString()}
						title={`Recorded ${new Date(row.at).toLocaleString()}`}
						class="shrink-0 text-[10px] text-ink-muted/70">{relativeTime(row.at)}</time
					>
				</li>
			{/each}
		</ul>
	{/if}
</FloatingSurface>
