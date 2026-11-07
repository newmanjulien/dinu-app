<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import { ConvexError } from 'convex/values';
	import { useConvexClient } from 'convex-svelte';
	import type { FunctionArgs, FunctionReturnType } from 'convex/server';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { api as backend } from '../../../convex/_generated/api';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import Button from '$lib/ui/Button.svelte';
	import IconButton from '$lib/ui/IconButton.svelte';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
	import { useCsmPreload, type CsmOwner } from './csm-preload.svelte';
	import type { CalendarSelection } from './csm-availability';
	import {
		addDays,
		addMonths,
		dateLabel,
		dateValue,
		grid,
		groupSlots,
		slotLabels,
		localDate,
		timeLabel,
		timeZones
	} from './csm-calendar';

	type Availability = FunctionReturnType<typeof backend.csmBookings.availability>;
	type Receipt = NonNullable<FunctionReturnType<typeof backend.csmBookings.attempt>>;
	let {
		owner,
		initial,
		onBooked
	}: { owner: CsmOwner; initial: CalendarSelection; onBooked: () => void } = $props();
	const preload = useCsmPreload();
	const client = useConvexClient(),
		viewer = useViewer();
	const id = $props.id();
	const mode = untrack(() => initial.mode);
	const replacement = untrack(() => initial.replacement);
	type Shared = FunctionReturnType<typeof backend.csmBookings.replacementStatus>;
	let shared = $state<Shared>();
	let sharedLoaded = $state(!replacement);
	let sharedError = $state(false);
	const initialZone = untrack(() => initial.timeZone);
	let timeZone = $state(initialZone);
	const zones = timeZones(initialZone);
	let today = $derived(localDate(new Date(), timeZone));
	let month = $state(untrack(() => initial.month));
	let selectedDate = $state(localDate(new Date(), initialZone));
	let cursor = $state(localDate(new Date(), initialZone));
	let selectedSlot = $state<string>();
	let calendar = $state<Availability>();
	let loading = $state(true);
	let readError = $state('');
	let message = $state('');
	let receipt = $state<Receipt | null>(null);
	let attemptId = $state<Id<'csmBookingAttempts'>>();
	let bootLoaded = $state(false);
	let bootError = $state(false);
	let bootRetry = $state(0);
	let refresh = $state(0);
	let mounted = $state(false);
	let submitting = $state(false);
	let bindingGeneration = $state(0);
	let checking = $state(false);
	let intent: FunctionArgs<typeof backend.csmBookings.book> | undefined;
	let root: AbortController;
	let membershipId: Id<'memberships'>;
	let dateGrid = $state<HTMLTableElement>();
	let progressPanel = $state<HTMLDivElement>();

	const ownPending = $derived(
		submitting || (!!receipt && ['queued', 'submitting', 'unknown'].includes(receipt.state))
	);
	const blocked = $derived(
		ownPending || shared?.state === 'in-progress' || shared?.state === 'uncertain'
	);
	const rows = $derived(grid(month));
	const lastDate = $derived(calendar?.lastDate ?? addDays(today, 370));
	const grouped = $derived(groupSlots(calendar?.slots ?? [], timeZone));
	const daySlots = $derived(grouped.get(selectedDate) ?? []);
	const availableDates = $derived(new Set(grouped.keys()));
	const labels = $derived(
		slotLabels(
			daySlots.map((s) => s.start),
			timeZone
		)
	);
	const current = () =>
		mounted &&
		!root.signal.aborted &&
		membershipId === viewer().membership.id &&
		preload.owner === owner &&
		owner.calendar.current();
	const interactive = () =>
		current() &&
		owner.canRead(mode, replacement) &&
		bootLoaded &&
		!bootError &&
		!blocked &&
		sharedLoaded &&
		!sharedError &&
		(!replacement || shared?.state === 'ready');
	const selectable = (date: string) =>
		interactive() &&
		!loading &&
		date.startsWith(month) &&
		date >= today &&
		date <= lastDate &&
		availableDates.has(date);

	onMount(() => {
		root = new AbortController();
		membershipId = viewer().membership.id;
		mounted = true;
		return () => {
			mounted = false;
			root.abort();
		};
	});

	function receive(
		row: Receipt | null,
		expectedGeneration: number,
		key: Id<'csmBookingAttempts'> | undefined
	) {
		if (!current() || expectedGeneration !== bindingGeneration) return;
		if (attemptId && key !== attemptId) return;
		if (key && row?.id !== key) return;
		// An unbound stream may acknowledge only this immutable operation. Another tab's
		// unresolved operation can be adopted only by the mutation's explicit acknowledgement.
		if (!key && intent && row?.operationId !== intent.operationId) return;
		const changed = row?.id !== receipt?.id || row?.state !== receipt?.state;
		receipt = row;
		if (row && !attemptId) attemptId = row.id;
		if (row) submitting = false;
		if (row?.state === 'booked') {
			owner.unresolved = false;
			owner.calendar.invalidate();
			onBooked();
			return;
		}
		const unresolved = !!row && ['queued', 'submitting', 'unknown'].includes(row.state);
		owner.unresolved = unresolved;
		if (unresolved && changed) owner.calendar.invalidate();
		if (row?.state === 'failed' && changed) {
			owner.calendar.invalidate();
			selectedSlot = undefined;
			message =
				row.error === 'conflict'
					? 'That time is no longer available. Please choose another.'
					: row.error === 'limit'
						? 'You already have an upcoming call. Use the link in your invitation to reschedule it.'
						: row.error === 'cancelled'
							? 'This booking was cancelled. You can choose another time.'
							: 'Your call wasn’t booked. Please try again.';
			refresh++;
			void tick().then(() => {
				if (current() && expectedGeneration === bindingGeneration)
					dateGrid
						?.querySelector<HTMLButtonElement>(`[data-date="${cursor}"]`)
						?.focus({ preventScroll: true });
			});
		}
	}
	/** Own the initial deadline and the continuing stream as one local lifetime. */
	function startInitialSubscription<T>(
		subscribe: (onValue: (value: T) => void, onError: () => void) => () => void,
		onValue: (value: T) => void,
		onFailure: () => void,
		isCurrent: () => boolean
	) {
		let active = true,
			release: (() => void) | undefined;
		const first = new ReadAttempt(15_000, root.signal);
		// Convex subscriptions aren't idempotent: clear ownership before invoking release.
		const stop = () => {
			const dispose = release;
			release = undefined;
			dispose?.();
		};
		const fail = () => {
			if (active && isCurrent()) onFailure();
			active = false;
			first.complete();
			stop();
		};
		first.signal.addEventListener('abort', fail, { once: true });
		try {
			if (first.signal.aborted) fail();
			else
				release = subscribe((value) => {
					if (!active || !isCurrent()) return;
					first.complete();
					onValue(value);
				}, fail);
			// A synchronous failure or abort can arrive before the handle is assigned.
			if (!active) stop();
		} catch {
			fail();
		}
		return () => {
			active = false;
			first.abort();
			stop();
		};
	}
	$effect(() => {
		if (!mounted || !replacement) return;
		void bootRetry;
		return untrack(() =>
			startInitialSubscription<Shared>(
				(value, error) =>
					client.onUpdate(
						backend.csmBookings.replacementStatus,
						{ membershipId, replacement },
						value,
						error
					),
				(row) => {
					if (shared?.state !== row.state) {
						owner.calendar.invalidate();
						selectedSlot = undefined;
						refresh++;
					}
					shared = row;
					sharedLoaded = true;
					sharedError = false;
					if (!intent && !attemptId && row.attemptId) attemptId = row.attemptId;
					if (row.state === 'replaced') {
						owner.unresolved = false;
						onBooked();
					}
				},
				() => {
					sharedError = true;
					sharedLoaded = false;
					owner.calendar.invalidate();
				},
				current
			)
		);
	});
	$effect(() => {
		if (!mounted) return;
		const key = attemptId,
			expectedGeneration = bindingGeneration;
		void bootRetry;
		return untrack(() => {
			bootLoaded = false;
			bootError = false;
			return startInitialSubscription<Receipt | null>(
				(value, error) =>
					client.onUpdate(
						backend.csmBookings.attempt,
						{
							membershipId,
							...(key ? { attemptId: key } : {}),
							...(replacement ? { replacement } : {})
						},
						value,
						error
					),
				(row) => {
					bootError = false;
					bootLoaded = true;
					receive(row, expectedGeneration, key);
				},
				() => {
					bootError = true;
					bootLoaded = false;
				},
				() => current() && expectedGeneration === bindingGeneration
			);
		});
	});
	$effect(() => {
		const target = month,
			zone = timeZone,
			revision = refresh;
		if (
			!mounted ||
			blocked ||
			owner.unresolved ||
			(replacement && (!sharedLoaded || sharedError || shared?.state !== 'ready'))
		)
			return;
		const request = new ReadAttempt(18_000, root.signal);
		let active = true;
		const selection = {
			mode,
			month: target,
			timeZone: zone,
			...(replacement ? { replacement } : {})
		};
		const canPaint = () =>
			active &&
			!request.signal.aborted &&
			current() &&
			(!replacement || (sharedLoaded && !sharedError && shared?.state === 'ready')) &&
			month === target &&
			timeZone === zone &&
			refresh === revision;
		const apply = (data: Availability) => {
			calendar = data;
			const days = [...grouped.keys()];
			if (!days.includes(selectedDate))
				selectedDate = days.includes(today)
					? today
					: (days[0] ?? (target === today.slice(0, 7) ? today : target + '-01'));
			if (!cursor.startsWith(target)) cursor = selectedDate;
			loading = false;
		};
		untrack(() => {
			readError = '';
			selectedSlot = undefined;
			const ready = owner.calendar.peek(selection);
			if (ready) {
				apply(ready);
				request.complete();
				return;
			}
			loading = true;
			calendar = undefined;
			void waitForRead(owner.calendar.read(selection), request.signal)
				.then(
					(data) => {
						if (canPaint()) apply(data);
					},
					() => {
						// A deadline is terminal for this waiter; accepted work may still warm the cache.
						if (
							active &&
							current() &&
							month === target &&
							timeZone === zone &&
							refresh === revision
						) {
							readError = 'The calendar couldn’t load. Please try again.';
							loading = false;
						}
					}
				)
				.finally(() => request.complete());
		});
		return () => {
			active = false;
			request.abort();
		};
	});
	function changeMonth(next: string) {
		if (!interactive() || next < today.slice(0, 7) || next > lastDate.slice(0, 7)) return;
		month = next;
		selectedSlot = undefined;
		selectedDate = next === today.slice(0, 7) ? today : next + '-01';
		cursor = selectedDate;
	}
	async function moveDate(event: KeyboardEvent, date: string) {
		let next: string;
		switch (event.key) {
			case 'ArrowLeft':
				next = addDays(date, -1);
				break;
			case 'ArrowRight':
				next = addDays(date, 1);
				break;
			case 'ArrowUp':
				next = addDays(date, -7);
				break;
			case 'ArrowDown':
				next = addDays(date, 7);
				break;
			case 'Home':
				next = addDays(date, -dateValue(date).getUTCDay());
				break;
			case 'End':
				next = addDays(date, 6 - dateValue(date).getUTCDay());
				break;
			case 'PageUp':
				next = addMonths(date, event.shiftKey ? -12 : -1);
				break;
			case 'PageDown':
				next = addMonths(date, event.shiftKey ? 12 : 1);
				break;
			default:
				return;
		}
		event.preventDefault();
		if (!interactive()) return;
		const firstMonth = today.slice(0, 7),
			lastMonth = lastDate.slice(0, 7);
		next =
			next.slice(0, 7) < firstMonth
				? firstMonth + '-01'
				: next.slice(0, 7) > lastMonth
					? lastDate
					: next;
		if (next.slice(0, 7) !== month) changeMonth(next.slice(0, 7));
		cursor = next;
		await tick();
		dateGrid
			?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)
			?.focus({ preventScroll: true });
	}
	function retryCalendar() {
		if (!interactive()) return;
		owner.calendar.invalidate();
		refresh++;
	}
	function retryBoot() {
		bootError = false;
		bootLoaded = false;
		bootRetry++;
	}
	async function submit(start: string) {
		if (
			!interactive() ||
			loading ||
			calendar?.status !== 'ready' ||
			selectedSlot !== start ||
			Date.parse(start) <= Date.now() ||
			!daySlots.some((s) => s.start === start)
		)
			return;
		owner.unresolved = true;
		owner.calendar.invalidate();
		// Freeze identity and replace the binding synchronously, before any continuation can run.
		intent = {
			membershipId,
			mode,
			operationId: crypto.randomUUID(),
			start,
			timeZone,
			...(replacement ? { replacement } : {}),
			receiptProtocol: 'creation-v1'
		};
		const expectedGeneration = ++bindingGeneration;
		receipt = null;
		attemptId = undefined;
		submitting = true;
		checking = false;
		message = '';
		await tick();
		if (!current() || expectedGeneration !== bindingGeneration) return;
		progressPanel?.focus({ preventScroll: true });
		await sendIntent();
	}
	async function sendIntent() {
		const args = intent,
			expectedGeneration = bindingGeneration;
		if (!args) return;
		const request = new ReadAttempt(25_000, root.signal);
		try {
			const ack = await waitForRead(
				client.mutation(backend.csmBookings.book, args),
				request.signal
			);
			if (!current() || expectedGeneration !== bindingGeneration || intent !== args || attemptId)
				return;
			if (!('attemptId' in ack)) throw new Error('Unsupported booking acknowledgement.');
			// Binding only. Delayed mutation responses never write receipt state.
			attemptId = ack.attemptId;
			if (ack.operationId !== args.operationId) intent = undefined;
		} catch (error) {
			if (!current() || expectedGeneration !== bindingGeneration || intent !== args || attemptId)
				return;
			if (error instanceof ConvexError) {
				submitting = false;
				intent = undefined;
				// Resume only after a fresh usable receipt, even for a definitive mutation error.
				bindingGeneration++;
				message =
					typeof error.data === 'string'
						? error.data
						: 'Your call wasn’t booked. Please try again.';
				return;
			}
			// The mutation may still commit. Check replays this same UUID until it can bind.
			message = 'We’re checking whether your call was booked.';
		} finally {
			request.complete();
		}
	}
	async function check() {
		if (checking || !current()) return;
		const expectedGeneration = bindingGeneration,
			key = attemptId;
		checking = true;
		message = '';
		const request = new ReadAttempt(35_000, root.signal);
		try {
			if (!key && intent) await sendIntent();
			else if (replacement && !key)
				await waitForRead(
					client.action(backend.csmBookings.checkReplacement, { membershipId, replacement }),
					request.signal
				);
			else if (key) {
				await waitForRead(
					client.action(backend.csmBookings.checkStatus, { membershipId, attemptId: key }),
					request.signal
				);
				if (current() && expectedGeneration === bindingGeneration)
					message =
						'Status checked. If your booking is still being confirmed, please check again shortly.';
			}
		} catch {
			if (current() && expectedGeneration === bindingGeneration)
				message = 'Booking status couldn’t be checked. Please try again shortly.';
		} finally {
			request.complete();
			if (current() && expectedGeneration === bindingGeneration) checking = false;
		}
	}
</script>

<section aria-labelledby={id + '-heading'} class="booking mt-8 @container">
	<div class="flex items-center justify-between gap-3">
		<div>
			<h3 id={id + '-heading'} class="text-[15px] font-medium">Book a video call</h3>
			<p class="mt-1 text-[13px] text-ink-muted">Choose a time that works for you.</p>
		</div>
		{#if calendar?.duration}<span
				class="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-muted"
				><ClockIcon class="size-[15px]" aria-hidden="true" />{calendar.duration} min</span
			>{/if}
	</div>
	<div
		class="mt-3 text-[12.5px] leading-relaxed text-ink-muted empty:hidden"
		role="status"
		aria-live="polite"
		aria-atomic="true"
	>
		{#if bootError || (sharedError && !ownPending)}Your booking status couldn’t load. Please try
			again.
		{:else if blocked}{message ||
				(receipt?.state === 'unknown' || submitting
					? 'We’re checking whether your call was booked.'
					: 'Booking your call…')}
		{:else if message}{message}
		{:else if replacement && sharedLoaded && shared?.state === 'unavailable'}This setup call’s
			details have changed. Close this window to see its latest status.
		{:else if !bootLoaded || !sharedLoaded || loading}Loading calendar…
		{:else if readError}{readError}
		{:else if calendar?.status === 'unavailable'}Booking is temporarily unavailable.
		{:else if !calendar?.slots.length}No times are available this month.
		{/if}
	</div>
	{#if bootError || (sharedError && !ownPending)}
		<Button variant="secondary" class="mt-3" onclick={retryBoot}>Retry</Button>
	{:else if blocked}
		<div
			bind:this={progressPanel}
			tabindex="-1"
			aria-labelledby={id + '-heading'}
			class="mt-3 rounded-lg border-hairline border-line p-5 outline-none"
		>
			{#if receipt}<p class="text-[13px]">
					{dateLabel(localDate(receipt.start, receipt.timeZone))} at {timeLabel(
						receipt.start,
						receipt.timeZone
					)} <span class="text-ink-muted">({receipt.timeZone.replaceAll('_', ' ')})</span>
				</p>{/if}
			<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">
				You can close this window while we confirm your booking. Reopen it to check its status.
			</p>
			{#if receipt?.state === 'unknown' || submitting || shared?.state === 'uncertain' || shared?.state === 'in-progress'}<Button
					variant="secondary"
					class="mt-4"
					disabled={checking}
					onclick={check}>{checking ? 'Checking…' : 'Check booking status'}</Button
				>{/if}
			{#if message}<p class="mt-3 text-[12.5px] text-ink-muted">{message}</p>{/if}
		</div>
	{:else if !replacement || !sharedLoaded || shared?.state === 'ready'}
		<div
			class="mt-5 grid grid-cols-1 rounded-lg border-hairline border-line @min-[520px]:grid-cols-[minmax(0,1fr)_208px]"
			aria-busy={loading || !bootLoaded}
		>
			<div class="min-w-0 px-4 py-3 @max-[290px]:px-2">
				<div class="mb-2 flex items-center justify-between gap-2">
					<h4 id={id + '-month'} class="text-[14px] font-medium">
						{dateLabel(month + '-01', { month: 'long', year: 'numeric' })}
					</h4>
					<div class="flex gap-1">
						<IconButton
							variant="ghost"
							aria-label="Previous month"
							disabled={!interactive() || month <= today.slice(0, 7)}
							onclick={() => changeMonth(addMonths(month + '-01', -1).slice(0, 7))}
							><CaretLeftIcon class="size-4" aria-hidden="true" /></IconButton
						>
						<IconButton
							variant="ghost"
							aria-label="Next month"
							disabled={!interactive() || month >= lastDate.slice(0, 7)}
							onclick={() => changeMonth(addMonths(month + '-01', 1).slice(0, 7))}
							><CaretRightIcon class="size-4" aria-hidden="true" /></IconButton
						>
					</div>
				</div>
				<table
					bind:this={dateGrid}
					role="grid"
					aria-labelledby={id + '-month'}
					class="w-full table-fixed border-separate border-spacing-0 text-center"
				>
					<thead
						><tr
							>{#each ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as day}<th
									scope="col"
									class="h-7 text-[11px] font-normal text-ink-muted"
									><span aria-label={day}>{day.slice(0, 1)}</span></th
								>{/each}</tr
						></thead
					>
					<tbody
						>{#each rows as week}<tr
								>{#each week as date}<td
										role="gridcell"
										aria-selected={selectedDate === date}
										class="p-0.5"
									>
										{#if date.startsWith(month)}<button
												type="button"
												data-date={date}
												tabindex={cursor === date ? 0 : -1}
												aria-label={dateLabel(date)}
												aria-current={date === today ? 'date' : undefined}
												aria-disabled={!selectable(date)}
												class={[
													'flex min-h-7 w-full items-center justify-center rounded-md text-[13px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
													selectable(date)
														? selectedDate === date
															? 'cursor-pointer bg-ink font-medium text-surface hover:bg-ink-secondary'
															: 'cursor-pointer bg-canvas font-medium text-ink hover:bg-control-hover'
														: 'text-ink-muted opacity-45',
													date === today && 'underline underline-offset-4'
												]}
												onfocus={() => {
													if (interactive()) cursor = date;
												}}
												onkeydown={(e) => moveDate(e, date)}
												onclick={() => {
													if (selectable(date)) {
														selectedDate = date;
														cursor = date;
														selectedSlot = undefined;
													}
												}}>{Number(date.slice(-2))}</button
											>
										{:else}<span class="block h-7" aria-hidden="true"></span>{/if}
									</td>{/each}</tr
							>{/each}</tbody
					>
				</table>
			</div>
			<div
				class="flex min-w-0 flex-col border-t-[length:var(--surface-border-width)] border-line px-4 py-3 @min-[520px]:col-start-2 @min-[520px]:row-start-1 @min-[520px]:min-h-0 @min-[520px]:border-t-0 @min-[520px]:border-l-[length:var(--surface-border-width)] @min-[520px]:[contain:size] @max-[290px]:px-2"
			>
				<h4 class="mb-3 flex min-h-8 shrink-0 items-center text-[13px] font-medium">
					{dateLabel(selectedDate, { weekday: 'short', month: 'short', day: 'numeric' })}
				</h4>
				<div
					class="-m-0.5 min-h-0 max-h-37 overflow-y-auto p-0.5 [scrollbar-gutter:stable] @min-[520px]:max-h-none"
				>
					{#if readError}<p class="text-[12.5px] leading-relaxed text-ink-muted">
							The calendar couldn’t load.
						</p>
						<Button
							variant="secondary"
							class="mt-3"
							disabled={!interactive()}
							onclick={retryCalendar}>Retry</Button
						>
					{:else if calendar?.status === 'unavailable'}<p
							class="text-[12.5px] leading-relaxed text-ink-muted"
						>
							Please try again later.
						</p>
						<Button
							variant="secondary"
							class="mt-3"
							disabled={!interactive()}
							onclick={retryCalendar}>Retry</Button
						>
					{:else if loading}<div class="space-y-2" aria-hidden="true">
							{#each [0, 1, 2, 3] as skeleton}<div
									class="h-11 rounded-md bg-canvas motion-safe:animate-pulse"
								></div>{/each}
						</div>
					{:else if !daySlots.length}<p class="text-[12.5px] leading-relaxed text-ink-muted">
							No times available. Choose another date.
						</p>
					{:else}<div class="space-y-2">
							{#each daySlots as slot (slot.start)}{@const label = labels.get(slot.start)!}
								<div class="flex gap-2">
									<button
										type="button"
										class={[
											'slot-button min-h-11 min-w-0 flex-1 cursor-pointer rounded-md border-hairline px-1 py-2 text-[12.5px] text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
											selectedSlot === slot.start
												? 'border-ink-muted bg-canvas'
												: 'border-line hover:bg-control-hover'
										]}
										aria-pressed={selectedSlot === slot.start}
										disabled={!interactive()}
										onclick={() => {
											if (interactive()) selectedSlot = slot.start;
										}}>{label.display}</button
									>
									{#if selectedSlot === slot.start}<Button
											class="h-11 flex-1"
											aria-label={'Book ' + dateLabel(selectedDate) + ' at ' + label.full}
											disabled={!interactive()}
											onclick={() => submit(slot.start)}>Book</Button
										>{/if}
								</div>{/each}
						</div>{/if}
				</div>
			</div>
			<div
				class="col-span-full flex min-w-0 items-center gap-2.5 border-t-[length:var(--surface-border-width)] border-line px-4 py-3 @min-[520px]:row-start-2 @max-[290px]:flex-col @max-[290px]:items-stretch @max-[290px]:gap-1 @max-[290px]:px-2"
			>
				<label for={id + '-zone'} class="shrink-0 text-[12px] text-ink-muted">Time zone</label>
				<div class="relative min-w-0 flex-1">
					<select
						id={id + '-zone'}
						class="w-full rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control outline-none transition-[background-color] focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 motion-reduce:transition-none min-w-0 text-[13px] placeholder:font-[350] placeholder:text-ink-muted text-ink disabled:bg-canvas disabled:text-ink-muted [&[readonly]]:bg-canvas [&[readonly]]:text-ink-muted h-9 cursor-pointer appearance-none truncate py-0 pr-9 leading-5 disabled:cursor-default"
						value={timeZone}
						disabled={!interactive()}
						onchange={(e) => {
							if (!interactive()) return;
							timeZone = e.currentTarget.value;
							selectedSlot = undefined;
						}}
						>{#each zones as zone}<option value={zone}>{zone.replaceAll('_', ' ')}</option
							>{/each}</select
					>
					<CaretDownIcon
						aria-hidden="true"
						class="size-3.5 pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted"
					/>
				</div>
			</div>
		</div>
	{/if}
</section>
