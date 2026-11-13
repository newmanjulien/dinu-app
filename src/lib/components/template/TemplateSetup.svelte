<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import type { FunctionReturnType } from 'convex/server';
	import { page } from '$app/state';
	import { useConvexClient } from 'convex-svelte';
	import { ConvexError } from 'convex/values';
	import { useClerkContext } from 'svelte-clerk';
	import { env } from '$env/dynamic/public';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import { api } from '../../../convex/_generated/api';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import FileTextIcon from 'phosphor-svelte/lib/FileTextIcon';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
	import CircleNotchIcon from 'phosphor-svelte/lib/CircleNotchIcon';
	import { DOCX_MAX_BYTES, type ImportIssue } from '$lib/document/import/limits';
	import { saveError } from '$lib/contract/saved';
	import Button from '$lib/ui/Button.svelte';
	import { initialCalendar, useCsmPreload } from '$lib/components/chrome/csm-preload.svelte';
	import CsmBooking from '$lib/components/chrome/CsmBooking.svelte';
	import TemplateSetupLayout from './TemplateSetupLayout.svelte';
	const preload = useCsmPreload();
	let { getNavigationIntent }: { getNavigationIntent: () => number } = $props();
	const viewer = useViewer();
	const session = useViewerSession();
	const client = useConvexClient();
	const clerk = useClerkContext();
	const membershipId = $derived(viewer().membership.id);
	const admin = $derived(viewer().membership.role === 'admin');
	let fileInput = $state<HTMLInputElement>();
	let fileName = $state('');
	let choosingAnother = $state(false);
	let bookingInProgress = $state(false);
	let issues = $state.raw<ImportIssue[]>([]);
	let parsing = $state(false);
	let uploadError = $state('');
	let dragDepth = $state(0);
	let generation = 0;
	let attempt: ReadAttempt | undefined;
	const errors = $derived(issues.filter((i) => i.severity === 'error'));
	const blocked = $derived(errors.length > 0);
	type SetupStatus = FunctionReturnType<typeof api.templateUploads.status>;
	let observed = $state.raw<{ identity: string; data?: SetupStatus; error?: string }>();
	let statusRetry = $state(0);
	const identity = $derived(
		admin &&
			session.preparedSessionId &&
			!session.blocked &&
			!session.closing &&
			!viewer().company.deletionPending
			? JSON.stringify([
					session.userId,
					session.preparedSessionId,
					session.transportGeneration,
					membershipId,
					viewer().company.id
				])
			: undefined
	);
	const status = $derived(observed?.identity === identity ? observed?.data : undefined);
	const statusError = $derived(observed?.identity === identity ? observed?.error : undefined);
	const canUpload = $derived(status?.kind === 'upload' || status?.kind === 'waiting');
	const pending = $derived(
		status?.kind === 'waiting' || status?.kind === 'booking' ? status.pending : null
	);
	const ready = $derived(status?.kind === 'waiting' && !choosingAnother && !blocked && !parsing);
	const busy = $derived(parsing);
	const owner = $derived(preload.owner);
	const booking = $derived(status?.kind === 'booking' ? status.booking : undefined);
	// The calendar freezes its operation target. State-only updates keep the same instance.
	const calendarKey = $derived(
		owner && booking
			? JSON.stringify([
					identity,
					booking.kind,
					booking.kind === 'replacement' ? booking.appointmentId : null,
					booking.kind === 'replacement' ? booking.currentUid : null
				])
			: undefined
	);
	$effect(() => {
		const currentIdentity = identity,
			currentMembership = membershipId;
		void statusRetry;
		if (!currentIdentity) return;
		return untrack(() => {
			let active = true,
				release: (() => void) | undefined;
			observed = { identity: currentIdentity };
			const read = new ReadAttempt(15_000);
			const current = () => active && identity === currentIdentity;
			const stop = () => {
				const dispose = release;
				release = undefined;
				dispose?.();
			};
			const fail = () => {
				if (current())
					observed = {
						identity: currentIdentity,
						error: 'Your setup status couldn’t load. Please try again.'
					};
				active = false;
				read.complete();
				stop();
			};
			read.signal.addEventListener('abort', fail, { once: true });
			try {
				release = client.onUpdate(
					api.templateUploads.status,
					{ membershipId: currentMembership },
					(data) => {
						if (current()) {
							read.complete();
							observed = { identity: currentIdentity, data };
						}
					},
					fail
				);
				if (!active) stop();
			} catch {
				fail();
			}
			return () => {
				active = false;
				read.abort();
				stop();
			};
		});
	});
	$effect(() => {
		void identity;
		untrack(() => {
			resetUpload();
			choosingAnother = false;
		});
	});
	$effect(() => {
		if (!canUpload)
			untrack(() => {
				cancel();
				parsing = false;
			});
	});
	$effect(() => {
		if (status?.kind === 'upload' && !choosingAnother && !parsing) untrack(() => resetUpload());
	});
	const dragging = $derived(dragDepth > 0 && !busy);
	function findText(context: string) {
		const text = context.replace(/\s+/g, ' ').trim();
		return text.length > 100 ? `${text.slice(0, 100).trimEnd()}…` : text;
	}
	function cancel() {
		generation++;
		attempt?.abort();
		attempt = undefined;
	}
	onDestroy(cancel);
	function resetUpload(name = '') {
		cancel();
		issues = [];
		uploadError = '';
		fileName = name;
		parsing = false;
	}
	function chooseFile() {
		if (!fileInput || busy || !canUpload || session.closing) return;
		choosingAnother = true;
		fileInput.value = '';
		fileInput.click();
	}
	function selectFiles(files: FileList | null) {
		if (!files?.length || !admin || !canUpload || busy) return;
		if (files.length !== 1) {
			resetUpload();
			uploadError = 'Upload one Word document at a time.';
			return;
		}
		void upload(files[0]);
	}
	function dragEnter(event: DragEvent) {
		if (!event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
		if (!busy) dragDepth++;
	}
	function dragOver(event: DragEvent) {
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
	}
	function drop(event: DragEvent) {
		event.preventDefault();
		dragDepth = 0;
		selectFiles(event.dataTransfer?.files ?? null);
	}
	async function upload(file: File) {
		choosingAnother = true;
		resetUpload(file.name);
		if (!/\.docx$/i.test(file.name)) {
			uploadError = 'Choose a .docx Word document.';
			return;
		}
		if (file.size > DOCX_MAX_BYTES) {
			uploadError = 'Choose a DOCX no larger than 10 MB.';
			return;
		}
		parsing = true;
		const current = generation;
		const active = uploadAccess();
		const read = new ReadAttempt(30000);
		attempt = read;
		try {
			if (!active()) return;
			if (!clerk.session) throw new Error('Sign in again to upload your template.');
			const token = await waitForRead(clerk.session.getToken({ template: 'convex' }), read.signal);
			if (!active()) return;
			if (!token) throw new Error('Sign in again to upload your template.');
			const url = new URL(
				'/templates/upload',
				env.PUBLIC_CONVEX_URL!.replace('.convex.cloud', '.convex.site')
			);
			url.searchParams.set('membershipId', membershipId);
			url.searchParams.set('filename', file.name);
			const pendingUpload = fetch(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
				},
				body: file,
				signal: read.signal
			});
			const response = await waitForRead(pendingUpload, read.signal);
			const result: unknown = await waitForRead(response.json(), read.signal);
			if (!active()) return;
			if (!result || typeof result !== 'object')
				throw new Error('Unable to read the upload response. Try again.');
			if (!response.ok)
				throw new ConvexError(
					'error' in result && typeof result.error === 'string'
						? result.error
						: 'Unable to upload your template. Try again.'
				);
			if (
				!('pendingTemplateSourceId' in result) ||
				(result.pendingTemplateSourceId !== null &&
					typeof result.pendingTemplateSourceId !== 'string') ||
				!('issues' in result) ||
				!Array.isArray(result.issues) ||
				!result.issues.every(
					(value): value is ImportIssue =>
						value &&
						typeof value === 'object' &&
						(value.severity === 'warning' || value.severity === 'error') &&
						typeof value.location === 'string' &&
						typeof value.message === 'string' &&
						(value.context === undefined || typeof value.context === 'string')
				)
			)
				throw new Error('Unable to read the upload response. Try again.');
			if (result.pendingTemplateSourceId) choosingAnother = false;
			issues = result.issues;
		} catch (cause) {
			if (active()) {
				uploadError = read.signal.aborted
					? 'The upload took too long. Try again.'
					: saveError(cause, 'Unable to upload your template. Try again.');
			}
		} finally {
			read.complete();
			if (generation === current) {
				parsing = false;
				attempt = undefined;
			}
		}
	}
	function uploadAccess() {
		const current = generation,
			userId = session.userId,
			prepared = session.preparedSessionId,
			transport = session.transportGeneration,
			member = membershipId,
			intent = getNavigationIntent(),
			route = page.url.href;
		return () =>
			generation === current &&
			!session.closing &&
			session.userId === userId &&
			session.preparedSessionId === prepared &&
			session.transportGeneration === transport &&
			viewer().membership.id === member &&
			canUpload &&
			getNavigationIntent() === intent &&
			page.url.href === route;
	}
</script>

{#snippet content()}
	{#if statusError}
		<p role="alert" class="text-[13px] leading-6 text-danger">{statusError}</p>
		<Button variant="secondary" class="mt-3" onclick={() => statusRetry++}>Try again</Button>
	{:else if status?.kind === 'booking'}
		{#if !bookingInProgress && pending}
			<p role="status" class="mt-4 text-[13px] leading-6 text-ink-muted">
				Your upload, <span class="font-medium text-ink">{pending.filename}</span>, is still saved.
				Book a new time to continue setup.
			</p>
		{/if}
		{#if owner && calendarKey && booking}
			{#key owner}
				{#key calendarKey}
					<CsmBooking
						{owner}
						bind:inProgress={bookingInProgress}
						initial={{
							...initialCalendar('setup'),
							...(booking.kind === 'replacement'
								? {
										replacement: {
											appointmentId: booking.appointmentId,
											currentUid: booking.currentUid
										}
									}
								: {})
						}}
						admission={booking.kind === 'unavailable' ? 'unavailable' : booking.state}
						description="Choose a time to get your template ready together."
						onBooked={() => {}}
					/>
				{/key}
			{/key}
		{:else}
			<p role="status" class="mt-4 text-[13px] leading-6 text-ink-muted">
				Your booking details are being checked. Booking is temporarily unavailable.
			</p>
		{/if}
	{:else if canUpload}
		{#if !ready}
			<p class="mb-4 text-[13px] leading-6 text-ink-muted">
				Upload a Word document (optional).
			</p>
			{#if pending}<p class="mb-4 text-[13px] leading-6 text-ink-muted">
					Your previous file, {pending.filename}, stays saved until a new upload succeeds.
				</p>{/if}
		{/if}
		<input
			bind:this={fileInput}
			type="file"
			accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
			aria-label="Choose a Word document"
			class="hidden"
			onchange={(event) => selectFiles(event.currentTarget.files)}
			disabled={busy}
		/>
		<section
			aria-label={ready ? 'Waiting for Julien' : 'Upload template'}
			class={[
				'group relative flex min-h-[283px] flex-col items-center justify-center rounded-2xl px-5 py-8 text-center transition-colors motion-reduce:transition-none sm:px-10',
				parsing
					? 'bg-[color-mix(in_srgb,var(--color-accent)_5%,var(--color-surface))]'
					: ready
						? 'bg-[color-mix(in_srgb,var(--color-success)_4%,var(--color-surface))]'
						: dragging
							? 'bg-[color-mix(in_srgb,var(--color-canvas)_40%,var(--color-surface))]'
							: 'bg-surface hover:bg-[color-mix(in_srgb,var(--color-canvas)_20%,var(--color-surface))] focus-within:bg-[color-mix(in_srgb,var(--color-canvas)_20%,var(--color-surface))]'
			]}
			ondragenter={dragEnter}
			ondragover={dragOver}
			ondragleave={() => (dragDepth = Math.max(0, dragDepth - 1))}
			ondrop={drop}
		>
			<svg
				class="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
				aria-hidden="true"
			>
				<rect
					x="0.5"
					y="0.5"
					width="calc(100% - 1px)"
					height="calc(100% - 1px)"
					rx="15"
					fill="none"
					stroke="var(--color-edge)"
					stroke-width="1"
					stroke-dasharray={parsing || ready ? undefined : '7 5'}
					class={[
						'transition-colors motion-reduce:transition-none',
						parsing
							? 'stroke-accent/30'
							: ready
								? 'stroke-success/20'
								: 'group-hover:stroke-ink-muted/30 group-focus-within:stroke-ink-muted/30',
						dragging && 'stroke-ink-muted/30'
					]}
				/>
			</svg>
			<div class="mb-3 flex size-9 items-center justify-center" aria-hidden="true">
				{#if parsing}
					<CircleNotchIcon class="size-7 animate-spin text-accent motion-reduce:animate-none" />
				{:else if ready}
					<CheckCircleIcon class="size-7 text-success" />
				{:else}
					<FileTextIcon class="size-7 text-ink-muted" />
				{/if}
			</div>
			<div role="status" aria-atomic="true" class="w-full">
				<h2 class="text-[15.5px] leading-6 font-medium text-ink [overflow-wrap:anywhere]">
					{parsing
						? 'Checking your template…'
						: ready
							? 'Waiting for Julien'
							: dragging
								? 'Drop your Word document here'
								: fileName || 'Drop your Word document here'}
				</h2>
				<p class="mx-auto mt-1.5 max-w-[440px] text-[13px] leading-5 text-ink-muted">
					{#if ready}
						<span class="block truncate font-medium text-ink" title={pending?.filename}
							>{pending?.filename}</span
						>
						Your document is saved. Julien will make your template available after preparing it. You can
						wait for your call.
					{:else if parsing}
						<span class="block truncate" title={fileName}>{fileName}</span>
					{:else if uploadError}
						Choose a new file to try again.
					{:else if blocked}
						A few corrections are needed before continuing.
					{:else}
						Or choose a Word file from your computer.
					{/if}
				</p>
			</div>
			{#if ready}
				<Button
					variant="secondary"
					class="mt-5"
					disabled={busy || session.closing}
					onclick={chooseFile}>Choose another file</Button
				>
			{:else if !parsing}
				<Button
					class={[
						'bg-accent text-white not-disabled:not-aria-disabled:hover:bg-accent-hover',
						'mt-5'
					]}
					onclick={chooseFile}
					disabled={busy}>{fileName ? 'Choose another file' : 'Choose a Word file'}</Button
				>
			{/if}
		</section>
	{:else if status?.kind === 'released'}
		<p role="status" class="text-[13px] leading-6 text-ink-muted">
			Opening your company’s template…
		</p>
	{/if}

	{#if admin && canUpload}
		{#if uploadError}
			<p
				role="alert"
				class="mt-4 rounded-button-xl border-hairline border-danger/20 bg-danger-surface shadow-card px-5 py-4 text-[13px] leading-6 text-danger"
			>
				{uploadError}
			</p>
		{/if}

		{#if blocked}
			<section
				aria-labelledby="template-corrections"
				role="alert"
				class="mt-4 rounded-base border-hairline border-edge bg-surface shadow-card p-4"
			>
				<h2 id="template-corrections" class="text-sm leading-6 font-medium text-ink">
					{errors.length === 1 ? 'One correction' : `${errors.length} corrections`} before continuing
				</h2>
				<p class="mt-1 text-[13px] leading-6 text-ink-muted">
					Make {errors.length === 1 ? 'this correction' : 'these corrections'} in Word, save the file,
					and upload it again.
				</p>
				<ul
					class="mt-3 divide-y-[length:var(--surface-border-width)] divide-line border-t-[length:var(--surface-border-width)] border-line text-[13px] leading-6"
				>
					{#each errors as issue}
						<li class="py-3 last:pb-0">
							<p class="text-ink">{issue.message}</p>
							{#if issue.context}
								<p class="mt-1 text-ink-muted [overflow-wrap:anywhere]">
									Find in Word: “{findText(issue.context)}”
								</p>
							{:else}
								<p class="mt-1 text-ink-muted">{issue.location}</p>
							{/if}
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
{/snippet}

<TemplateSetupLayout
	role={viewer().membership.role}
	bookingInProgress={status?.kind === 'booking' && bookingInProgress}
	children={admin && (status || statusError) ? content : undefined}
/>
