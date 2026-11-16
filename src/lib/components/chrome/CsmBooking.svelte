<script lang="ts">
	import CsmTimeListLayout from './CsmTimeListLayout.svelte';
	import { withinBookingWindow } from '$lib/booking-window';
	import CsmBookingLayout from './CsmBookingLayout.svelte';
	import { onMount, tick, untrack } from 'svelte';
	import { ConvexError } from 'convex/values';
	import { useConvexClient } from 'convex-svelte';
	import type { FunctionArgs, FunctionReturnType } from 'convex/server';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { api as backend } from '../../../convex/_generated/api';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import Button from '$lib/ui/Button.svelte';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
	import CircleNotchIcon from 'phosphor-svelte/lib/CircleNotchIcon';
	import { useCsmPreload, type CsmOwner } from './csm-preload.svelte';
	import type { AvailabilitySelection } from './csm-availability';
	import { dateLabel, groupSlots, slotLabels, localDate, timeLabel, timeZones } from './csm-time';

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
		initial: AvailabilitySelection;
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
	let now = $state(Date.now());
	let selectedSlot = $state<string>();
	let availability = $state<Availability>();
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
	let intent: FunctionArgs<typeof backend.csmBookings.book> | undefined;
	let root: AbortController;
	let membershipId: Id<'memberships'>;
	let timeList = $state<HTMLDivElement>();
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
	const slots = $derived(
		(availability?.slots ?? []).filter((slot) => withinBookingWindow(slot.start, now))
	);
	const grouped = $derived(groupSlots(slots, timeZone));
	const labels = $derived(
		new Map(
			[...grouped.values()].flatMap((day) => [
				...slotLabels(
					day.map((slot) => slot.start),
					timeZone
				)
			])
		)
	);
	const current = () =>
		mounted &&
		!root.signal.aborted &&
		membershipId === owner.membershipId &&
		preload.owner === owner &&
		owner.availability.current();
	const interactive = () =>
		current() &&
		owner.canRead(mode, replacement) &&
		bootLoaded &&
		!bootError &&
		!blocked &&
		sharedLoaded &&
		!sharedError &&
		(mode !== 'setup' || shared?.state === 'ready');

	onMount(() => {
		root = new AbortController();
		membershipId = owner.membershipId;
		mounted = true;
		const onVisible = () => {
			if (document.hidden) return;
			now = Date.now();
			if (
				interactive() &&
				!loading &&
				availability?.status === 'ready' &&
				!owner.availability.peek({ mode, timeZone, ...(replacement ? { replacement } : {}) })
			)
				refresh++;
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			document.removeEventListener('visibilitychange', onVisible);
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
			owner.availability.invalidate();
			onBooked();
			return;
		}
		const unresolved = !!row && ['queued', 'submitting', 'unknown'].includes(row.state);
		owner.setUnresolved(unresolved);
		if (unresolved && changed) owner.availability.invalidate();
		if (row?.state === 'failed' && changed) {
			owner.availability.invalidate();
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
					(timeList?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? timeList)?.focus({
						preventScroll: true
					});
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
					if (shared && shared.state !== row.state) {
						owner.availability.invalidate();
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
					owner.availability.invalidate();
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
		const zone = timeZone,
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
			timeZone: zone,
			...(replacement ? { replacement } : {})
		};
		const canPaint = () =>
			active &&
			!request.signal.aborted &&
			current() &&
			(mode !== 'setup' || (sharedLoaded && !sharedError && shared?.state === 'ready')) &&
			timeZone === zone &&
			refresh === revision;
		const apply = (data: Availability) => {
			availability = data;
			now = Date.now();
			loading = false;
		};
		untrack(() => {
			readError = '';
			selectedSlot = undefined;
			const ready = owner.availability.peek(selection);
			if (ready) {
				apply(ready);
				request.complete();
				return;
			}
			loading = true;
			availability = undefined;
			void waitForRead(owner.availability.read(selection), request.signal)
				.then(
					(data) => {
						if (canPaint()) apply(data);
					},
					() => {
						// A deadline is terminal for this waiter; accepted work may still warm the cache.
						if (active && current() && timeZone === zone && refresh === revision) {
							readError = 'Available times couldn’t load. Please try again.';
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
	// Expire displayed starts at their actual instant, even if the picker stays open.
	$effect(() => {
		if (!mounted || blocked || !slots.length) return;
		const timer = setTimeout(
			() => {
				now = Date.now();
			},
			Math.max(1, Date.parse(slots[0].start) - Date.now() + 1)
		);
		return () => clearTimeout(timer);
	});
	$effect(() => {
		if (selectedSlot && !slots.some((slot) => slot.start === selectedSlot))
			selectedSlot = undefined;
	});
	// Refresh the rolling window at cache expiry; hidden tabs refresh when visible again.
	$effect(() => {
		if (!mounted || loading || availability?.status !== 'ready' || !interactive()) return;
		const expires = owner.availability.expiresAt({
			mode,
			timeZone,
			...(replacement ? { replacement } : {})
		});
		if (expires === undefined) return;
		const timer = setTimeout(
			() => {
				if (!document.hidden && interactive()) refresh++;
			},
			Math.max(1, expires - Date.now())
		);
		return () => clearTimeout(timer);
	});
	function chooseSlot(start: string) {
		now = Date.now();
		if (interactive() && !loading && withinBookingWindow(start, now)) selectedSlot = start;
	}
	function retryAvailability() {
		if (!interactive()) return;
		owner.availability.invalidate();
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
			availability?.status !== 'ready' ||
			selectedSlot !== start ||
			!withinBookingWindow(start, Date.now()) ||
			!slots.some((s) => s.start === start)
		)
			return;
		owner.setUnresolved(true);
		owner.availability.invalidate();
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
			{#if availability?.duration && !blocked}<span
					class="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-muted"
					><ClockIcon class="size-[15px]" aria-hidden="true" />{availability.duration} min</span
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
			{:else if availability?.status === 'unavailable'}Booking is temporarily unavailable.
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
			<CsmTimeListLayout loading={loading || !bootLoaded} timeZoneId={id + '-zone'}>
				<div bind:this={timeList} tabindex="-1" aria-label="Available times" class="outline-none">
					{#if readError || availability?.status === 'unavailable'}
						<p class="text-[12.5px] leading-relaxed text-ink-muted">
							{readError ? 'Available times couldn’t load.' : 'Please try again later.'}
						</p>
						<Button
							variant="secondary"
							class="mt-3"
							disabled={!interactive()}
							onclick={retryAvailability}>Retry</Button
						>
					{:else if loading}
						<span role="status" class="sr-only">Loading available times</span>
						<div class="space-y-1.5" aria-hidden="true">
							<SkeletonBlock class="mb-3 h-5 w-32" />
							{#each [0, 1, 2, 3] as skeleton}<SkeletonBlock
									class="h-button-sm rounded-button-lg"
								/>{/each}
						</div>
					{:else if !slots.length}
						<p role="status" class="text-[12.5px] leading-relaxed text-ink-muted">
							No available times in the next 2 days.
						</p>
					{:else}
						<div class="space-y-4">
							{#each [...grouped] as [date, daySlots] (date)}
								<section aria-labelledby={id + '-day-' + date}>
									<h4 id={id + '-day-' + date} class="mb-2 text-[14px] font-medium">
										{dateLabel(date, { weekday: 'short', month: 'short', day: 'numeric' })}
									</h4>
									<div class="space-y-1.5">
										{#each daySlots as slot (slot.start)}{@const label = labels.get(slot.start)!}
											<div class="flex gap-1.5">
												<button
													type="button"
													class={[
														'slot-button min-h-button-sm min-w-0 flex-1 cursor-pointer rounded-button-lg border-hairline border-line px-2 py-1.5 text-[12.5px] leading-5 text-ink transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:bg-canvas disabled:text-ink-muted motion-reduce:transition-none',
														selectedSlot === slot.start
															? 'bg-canvas'
															: 'enabled:hover:bg-field-hover'
													]}
													aria-pressed={selectedSlot === slot.start}
													disabled={!interactive()}
													onclick={() => chooseSlot(slot.start)}>{label.display}</button
												>
												{#if selectedSlot === slot.start}<Button
														class="h-auto min-h-button-sm min-w-0 flex-1 focus-visible:-outline-offset-2"
														aria-label={'Book ' + dateLabel(date) + ' at ' + label.full}
														disabled={!interactive()}
														onclick={() => submit(slot.start)}>Book</Button
													>{/if}
											</div>
										{/each}
									</div>
								</section>
							{/each}
						</div>
					{/if}
				</div>
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
			</CsmTimeListLayout>
		{/if}
	</CsmBookingLayout>
{/if}
