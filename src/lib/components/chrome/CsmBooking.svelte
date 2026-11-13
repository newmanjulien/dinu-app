<script lang="ts">
	import CsmCalendarLayout from './CsmCalendarLayout.svelte';
	import CsmCalendarDates from './CsmCalendarDates.svelte';
	import CsmBookingLayout from './CsmBookingLayout.svelte';
	import { onMount, tick, untrack } from 'svelte';
	import { ConvexError } from 'convex/values';
	import { useConvexClient } from 'convex-svelte';
	import type { FunctionArgs, FunctionReturnType } from 'convex/server';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { api as backend } from '../../../convex/_generated/api';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import Button from '$lib/ui/Button.svelte';
	import IconButton from '$lib/ui/IconButton.svelte';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
	import CircleNotchIcon from 'phosphor-svelte/lib/CircleNotchIcon';
	import { useCsmPreload, type CsmOwner } from './csm-preload.svelte';
	import type { CalendarSelection } from './csm-availability';
	import {
		addDays,
		addMonths,
		dateLabel,
		dateValue,
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
		onBooked,
		inProgress = $bindable(false),
		admission = 'ready',
		description = 'Choose a time that works for you.'
	}: {
		owner: CsmOwner;
		initial: CalendarSelection;
		onBooked: () => void;
		inProgress?: boolean;
		admission?: 'ready' | 'in-progress' | 'uncertain' | 'completed' | 'unavailable';
		description?: string;
	} = $props();
	const preload = useCsmPreload();
	const client = useConvexClient();
	const id = $props.id();
	const mode = untrack(() => initial.mode);
	const replacement = untrack(() => initial.replacement);
	type Shared = FunctionReturnType<typeof backend.csmBookings.setupStatus>;
	let shared = $state<Shared>();
	let sharedLoaded = $state(mode !== 'setup');
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
	let submissionUncertain = $state(false);
	let bindingGeneration = $state(0);
	let checking = $state(false);
	let findingDate = $state(false);
	let dateSearchMessage = $state('');
	let dateSearch: ReadAttempt | undefined;
	let intent: FunctionArgs<typeof backend.csmBookings.book> | undefined;
	let root: AbortController;
	let membershipId: Id<'memberships'>;
	let dateGrid = $state<HTMLTableElement>();
	let progressPanel = $state<HTMLDivElement>();

	const ownPending = $derived(
		submitting || (!!receipt && ['queued', 'submitting', 'unknown'].includes(receipt.state))
	);
	const blocked = $derived(
		ownPending ||
			(receipt?.state === 'booked' && receipt.mode === mode) ||
			admission !== 'ready' ||
			shared?.state === 'in-progress' ||
			shared?.state === 'uncertain' ||
			shared?.state === 'completed'
	);
	const needsRecovery = $derived(
		submissionUncertain ||
			receipt?.state === 'unknown' ||
			admission === 'uncertain' ||
			shared?.state === 'uncertain'
	);
	const bookingLoading = $derived(
		!bootError &&
			!(sharedError && !ownPending) &&
			!needsRecovery &&
			(ownPending ||
				admission === 'in-progress' ||
				shared?.state === 'in-progress' ||
				(receipt?.state === 'booked' && receipt.mode === mode))
	);
	$effect(() => {
		inProgress = blocked;
	});
	const navigationLastDate = $derived(addDays(today, 370));
	const lastDate = $derived(calendar?.lastDate ?? navigationLastDate);
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
		membershipId === owner.membershipId &&
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
		(mode !== 'setup' || shared?.state === 'ready');
	const selectable = (date: string) =>
		interactive() &&
		!loading &&
		date.startsWith(month) &&
		date >= today &&
		date <= lastDate &&
		availableDates.has(date);

	onMount(() => {
		root = new AbortController();
		membershipId = owner.membershipId;
		mounted = true;
		return () => {
			mounted = false;
			root.abort();
			inProgress = false;
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
		if (row) {
			submitting = false;
			submissionUncertain = false;
		}
		if (row?.state === 'booked') {
			owner.setUnresolved(false);
			owner.calendar.invalidate();
			onBooked();
			return;
		}
		const unresolved = !!row && ['queued', 'submitting', 'unknown'].includes(row.state);
		owner.setUnresolved(unresolved);
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
		if (!mounted || mode !== 'setup') return;
		void bootRetry;
		return untrack(() =>
			startInitialSubscription<Shared>(
				(value, error) =>
					client.onUpdate(
						backend.csmBookings.setupStatus,
						{ membershipId, ...(replacement ? { replacement } : {}) },
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
					if (row.state === 'completed') {
						owner.setUnresolved(false);
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
							mode,
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
			(mode === 'setup' && (!sharedLoaded || sharedError || shared?.state !== 'ready'))
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
			(mode !== 'setup' || (sharedLoaded && !sharedError && shared?.state === 'ready')) &&
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
	$effect(() => {
		void month;
		void timeZone;
		void refresh;
		void owner.unresolved;
		interactive();
		untrack(() => {
			dateSearchMessage = '';
		});
		return () => {
			dateSearch?.abort();
			dateSearch = undefined;
			findingDate = false;
		};
	});
	async function findAvailableDate() {
		if (!interactive() || loading || findingDate) return;
		const request = new ReadAttempt(18_000, root.signal);
		dateSearch = request;
		findingDate = true;
		dateSearchMessage = '';
		const zone = timeZone,
			firstDate = today,
			limit = lastDate < navigationLastDate ? lastDate : navigationLastDate;
		try {
			for (
				let target = firstDate.slice(0, 7);
				target <= limit.slice(0, 7);
				target = addMonths(target + '-01', 1).slice(0, 7)
			) {
				if (request.signal.aborted || !interactive()) return;
				const data = await waitForRead(
					owner.calendar.read({
						mode,
						month: target,
						timeZone: zone,
						...(replacement ? { replacement } : {})
					}),
					request.signal
				);
				if (request.signal.aborted || !interactive()) return;
				if (data.status !== 'ready') throw new Error('Calendar unavailable.');
				const end = data.lastDate && data.lastDate < limit ? data.lastDate : limit;
				const date = [...groupSlots(data.slots, zone).keys()]
					.filter((day) => day >= firstDate && day <= end)
					.sort()[0];
				if (date) {
					month = target;
					selectedDate = date;
					cursor = date;
					selectedSlot = undefined;
					return;
				}
				if (target >= end.slice(0, 7)) break;
			}
			dateSearchMessage = 'No available dates in the booking window.';
		} catch {
			if (dateSearch === request && interactive())
				dateSearchMessage = 'Couldn’t find available dates. Please try again.';
		} finally {
			request.complete();
			if (dateSearch === request) {
				dateSearch = undefined;
				findingDate = false;
			}
		}
	}
	function changeMonth(next: string) {
		if (!interactive() || next < today.slice(0, 7) || next > navigationLastDate.slice(0, 7)) return;
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
			lastMonth = navigationLastDate.slice(0, 7);
		next =
			next.slice(0, 7) < firstMonth
				? firstMonth + '-01'
				: next.slice(0, 7) > lastMonth
					? navigationLastDate
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
		owner.setUnresolved(true);
		owner.calendar.invalidate();
		// Freeze identity and replace the binding synchronously, before any continuation can run.
		intent = {
			membershipId,
			mode,
			operationId: crypto.randomUUID(),
			start,
			timeZone,
			...(replacement ? { replacement } : {})
		};
		const expectedGeneration = ++bindingGeneration;
		receipt = null;
		attemptId = undefined;
		submitting = true;
		submissionUncertain = false;
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
			submissionUncertain = true;
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
			else if (mode === 'setup' && !key)
				await waitForRead(
					client.action(backend.csmBookings.checkSetup, {
						membershipId,
						...(replacement ? { replacement } : {})
					}),
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

{#if bookingLoading}
	<div
		bind:this={progressPanel}
		tabindex="-1"
		aria-labelledby={id + '-progress-heading'}
		class="booking flex min-h-[300px] flex-col items-center justify-center px-6 py-12 text-center outline-none"
	>
		<CircleNotchIcon
			class="mb-4 size-7 animate-spin text-accent motion-reduce:animate-none"
			aria-hidden="true"
		/>
		<h2
			id={id + '-progress-heading'}
			role="status"
			aria-atomic="true"
			class="text-[15.5px] leading-6 font-medium text-ink"
		>
			{receipt?.state === 'booked' ? 'Your call is booked' : 'We’re booking your call…'}
		</h2>
	</div>
{:else}
	<CsmBookingLayout
		description={blocked ? 'Confirming your call' : description}
		headingId={id + '-heading'}
	>
		{#snippet duration()}
			{#if calendar?.duration && !blocked}<span
					class="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-muted"
					><ClockIcon class="size-[15px]" aria-hidden="true" />{calendar.duration} min</span
				>{/if}{/snippet}

		<div
			class="mt-3 text-[12.5px] leading-relaxed text-ink-muted empty:hidden"
			role="status"
			aria-live="polite"
			aria-atomic="true"
		>
			{#if bootError || (sharedError && !ownPending)}Your booking status couldn’t load. Please try
				again.
			{:else if receipt?.state === 'booked' && receipt.mode === mode}Your call is booked. Updating
				your setup status…
			{:else if blocked}{message ||
					(receipt?.state === 'unknown' || submitting
						? 'We’re checking whether your call was booked.'
						: admission === 'uncertain'
							? 'We’re checking the current setup booking. Please wait before choosing another time.'
							: admission === 'unavailable' || admission === 'completed'
								? 'Your setup booking details have changed. Please wait for the latest status.'
								: 'Booking your call…')}
			{:else if message}{message}
			{:else if mode === 'setup' && sharedLoaded && shared?.state === 'unavailable'}This setup
				call’s details have changed. Close this window to see its latest status.
			{:else if readError}{readError}
			{:else if calendar?.status === 'unavailable'}Booking is temporarily unavailable.
			{/if}
		</div>
		{#if bootError || (sharedError && !ownPending)}
			<Button variant="secondary" class="mt-3" onclick={retryBoot}>Retry</Button>
		{:else if blocked}
			<div
				bind:this={progressPanel}
				tabindex="-1"
				aria-labelledby={id + '-heading'}
				class="mt-3 rounded-base border-hairline border-line bg-surface p-4 outline-none"
			>
				{#if receipt}<p class="text-[13px]">
						{dateLabel(localDate(receipt.start, receipt.timeZone))} at {timeLabel(
							receipt.start,
							receipt.timeZone
						)} <span class="text-ink-muted">({receipt.timeZone.replaceAll('_', ' ')})</span>
					</p>{/if}
				<p class="mt-2 text-[13px] leading-relaxed text-ink-muted">
					{needsRecovery
						? 'Your booking is taking longer than expected. Check its status before choosing another time.'
						: 'We’ll continue once your latest booking details are confirmed.'}
				</p>
				{#if needsRecovery && (attemptId || submissionUncertain || mode === 'setup')}<Button
						variant="secondary"
						class="mt-4"
						disabled={checking}
						onclick={check}>{checking ? 'Checking…' : 'Check booking status'}</Button
					>{/if}
			</div>
		{:else if mode !== 'setup' || !sharedLoaded || shared?.state === 'ready'}
			<CsmCalendarLayout
				loading={loading || !bootLoaded}
				monthHeadingId={id + '-month'}
				timeZoneId={id + '-zone'}
			>
				{#snippet monthTitle()}{dateLabel(month + '-01', { month: 'long', year: 'numeric' })}
				{/snippet}
				{#snippet monthNavigation()}<IconButton
						variant="ghost"
						aria-label="Previous month"
						disabled={!interactive() || month <= today.slice(0, 7)}
						onclick={() => changeMonth(addMonths(month + '-01', -1).slice(0, 7))}
						><CaretLeftIcon class="size-4" aria-hidden="true" /></IconButton
					>
					<IconButton
						variant="ghost"
						aria-label="Next month"
						disabled={!interactive() || month >= navigationLastDate.slice(0, 7)}
						onclick={() => changeMonth(addMonths(month + '-01', 1).slice(0, 7))}
						><CaretRightIcon class="size-4" aria-hidden="true" /></IconButton
					>
				{/snippet}
				{#snippet dates()}<CsmCalendarDates
						{month}
						{selectedDate}
						labelledBy={id + '-month'}
						bind:element={dateGrid}
					>
						{#snippet day(date)}{#if date.startsWith(month)}<button
									type="button"
									data-date={date}
									tabindex={cursor === date ? 0 : -1}
									aria-label={dateLabel(date)}
									aria-current={date === today ? 'date' : undefined}
									aria-disabled={!selectable(date)}
									class={[
										'flex h-[31px] w-full items-center justify-center rounded-button-md text-[12.5px] font-normal transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent motion-reduce:transition-none',
										selectable(date)
											? selectedDate === date
												? 'cursor-pointer bg-ink text-surface hover:bg-ink-secondary'
												: 'cursor-pointer bg-canvas text-ink hover:bg-control-hover'
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
							{:else}<span class="block h-[31px]" aria-hidden="true"></span>{/if}{/snippet}
					</CsmCalendarDates>{/snippet}
				{#snippet timesTitle()}
					{dateLabel(selectedDate, { weekday: 'short', month: 'short', day: 'numeric' })}
				{/snippet}
				{#snippet times()}
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
					{:else if loading}<div class="space-y-1.5" aria-hidden="true">
							{#each [0, 1, 2, 3] as skeleton}<SkeletonBlock
									class="h-button-sm rounded-button-lg"
								/>{/each}
						</div>
					{:else if !availableDates.size}<p class="text-[12.5px] leading-relaxed text-ink-muted">
							No available times this month.
						</p>
						<button
							type="button"
							class="mt-2 cursor-pointer text-left text-[12.5px] leading-relaxed text-accent underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:text-ink-muted"
							disabled={!interactive() || findingDate}
							onclick={findAvailableDate}
							>{findingDate ? 'Finding available dates…' : 'Find next available date'}</button
						>
						{#if dateSearchMessage}<p
								role="status"
								class="mt-2 text-[12.5px] leading-relaxed text-ink-muted"
							>
								{dateSearchMessage}
							</p>{/if}
					{:else if !daySlots.length}<p class="text-[12.5px] leading-relaxed text-ink-muted">
							No times available. Choose another date.
						</p>
					{:else}<div class="space-y-1.5">
							{#each daySlots as slot (slot.start)}{@const label = labels.get(slot.start)!}
								<div class="flex gap-1.5">
									<button
										type="button"
										class={[
											'slot-button min-h-button-sm min-w-0 flex-1 cursor-pointer rounded-button-lg border-hairline border-line px-2 py-1.5 text-[12.5px] leading-5 text-ink transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:bg-canvas disabled:text-ink-muted motion-reduce:transition-none',
											selectedSlot === slot.start ? 'bg-canvas' : 'enabled:hover:bg-field-hover'
										]}
										aria-pressed={selectedSlot === slot.start}
										disabled={!interactive()}
										onclick={() => {
											if (interactive()) selectedSlot = slot.start;
										}}>{label.display}</button
									>
									{#if selectedSlot === slot.start}<Button
											class="h-auto min-h-button-sm min-w-0 flex-1 focus-visible:-outline-offset-2"
											aria-label={'Book ' + dateLabel(selectedDate) + ' at ' + label.full}
											disabled={!interactive()}
											onclick={() => submit(slot.start)}>Book</Button
										>{/if}
								</div>{/each}
						</div>{/if}{/snippet}
				{#snippet timeZoneControl()}<select
						id={id + '-zone'}
						class="h-9 w-full min-w-0 cursor-pointer appearance-none truncate rounded-button-lg border-hairline border-line bg-surface py-0 pr-9 pl-3 text-[13px] leading-5 text-ink outline-none transition-colors enabled:hover:not-focus:bg-field-hover focus:border-accent focus:outline-solid focus:outline-2 focus:outline-offset-1 focus:outline-accent/18 disabled:cursor-default disabled:bg-canvas disabled:text-ink-muted motion-reduce:transition-none"
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
				{/snippet}
			</CsmCalendarLayout>
		{/if}
	</CsmBookingLayout>
{/if}
