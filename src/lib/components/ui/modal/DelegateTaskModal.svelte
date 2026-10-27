<script lang="ts">
	import { onMount, onDestroy, tick, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import { ConvexError } from 'convex/values';
	import { useClerkContext } from 'svelte-clerk';
	import { env } from '$env/dynamic/public';
	import { api } from '../../../../convex/_generated/api';
	import type {
		Catalog,
		Submission,
		Submitted,
		Task
	} from '../../../../convex/delegationValidators';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import {
		ATTACHMENT_MAX_BYTES,
		ATTACHMENT_MAX_COUNT,
		DOCX_CONTENT_TYPE,
		PDF_CONTENT_TYPE,
		delegationDeadline,
		formatDelegationDeadline,
		nextDelegationMidnight
	} from '$lib/delegation';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import Button from '$lib/ui/Button.svelte';
	import { fieldClass, fieldShellClass, fieldInputClass } from '$lib/ui/field-styles';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	import FileTextIcon from 'phosphor-svelte/lib/FileTextIcon';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
	import PaperclipIcon from 'phosphor-svelte/lib/PaperclipIcon';
	import XIcon from 'phosphor-svelte/lib/XIcon';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';

	let {
		onClose,
		catalogData,
		catalogError,
		onCatalogRejected
	}: {
		onClose: () => void;
		catalogData: Catalog | null | undefined;
		catalogError: Error | undefined;
		onCatalogRejected: (snapshot: Catalog | null) => void;
	} = $props();
	const client = useConvexClient();
	const clerk = useClerkContext();
	const viewer = useViewer();
	const session = useViewerSession();
	const membershipId = viewer().membership.id;
	const userId = session.userId;
	const prepared = session.prepared;
	const transportGeneration = session.transportGeneration;
	const prefix = $props.id();
	const steps = ['Select a task', 'Configure', 'Complete'];
	let destroyed = false;
	let draftId = $state('');
	let step = $state(0);
	let taskKey = $state('');
	let answers = $state<Record<string, string>>({});
	let search = $state('');
	let searchInput = $state<HTMLInputElement>();
	let configuredRevision = $state<number | null>(null);
	let error = $state('');
	let uploadError = $state('');
	let saving = $state(false);
	let success = $state<Submitted | null>(null);
	let frozen = $state.raw<{ operationId: string; payload: Submission; catalog: Catalog } | null>(
		null
	);
	let delegateName = $state('');
	let pendingSubmission: Promise<Submitted> | undefined;
	let submitRead: ReadAttempt | undefined;
	type Upload = {
		key: string;
		uploadId: string;
		file: File;
		confirmed: boolean;
		unavailable: boolean;
		status: 'uploading' | 'removing' | 'error' | 'uploaded';
		error: string;
	};
	let uploads = $state<Upload[]>([]);
	const reads = new Map<string, { read: ReadAttempt; confirm: () => void }>();
	const removals = new SvelteMap<string, Promise<null>>();
	const removalReads = new Set<ReadAttempt>();
	let fileInput = $state<HTMLInputElement>();
	let now = $state(Date.now());
	let appliedRevision: number | undefined;
	// A temporary auth recovery blocks new work, but existing work may still settle.
	const active = () =>
		!destroyed &&
		!session.closing &&
		session.userId === userId &&
		session.prepared === prepared &&
		session.transportGeneration === transportGeneration &&
		viewer().membership.id === membershipId;
	const canDispatch = () => active() && !session.blocked;
	const filesEnabled = $derived(!!draftId && uploads.length > 0 && active() && !success);
	const filesArgs = $derived(filesEnabled ? { membershipId, draftId } : 'skip');
	const filesQuery = useQuery(api.delegation.draftAttachments, () => filesArgs);
	const catalog = $derived(frozen?.catalog ?? catalogData);
	const task = $derived(catalog?.tasks.find((t) => t.key === taskKey));
	const visibleTasks = $derived(
		catalog?.tasks.filter((t) => t.title.toLowerCase().includes(search.trim().toLowerCase())) ?? []
	);
	const locked = $derived(saving || !!frozen || !!success);
	const attached = $derived(
		uploads.map((upload) => {
			const row = filesQuery.data?.find((file) => file.uploadId === upload.uploadId);
			const attachmentId =
				!filesQuery.error && !upload.unavailable && row && row.expiresAt > now ? row._id : null;
			return {
				...upload,
				attachmentId,
				status: attachmentId && upload.status !== 'removing' ? 'uploaded' : upload.status
			};
		})
	);
	const uploadsPending = $derived(
		attached.some(
			(upload) =>
				upload.status === 'uploading' ||
				upload.status === 'removing' ||
				removals.has(upload.uploadId) ||
				!upload.attachmentId
		)
	);
	const preview = $derived(task ? delegationDeadline(now, task.businessDays) : '');
	const refreshClock = () => {
		now = Date.now();
	};
	onMount(() => {
		const visible = () => {
			if (document.visibilityState === 'visible') refreshClock();
		};
		document.addEventListener('visibilitychange', visible);
		return () => document.removeEventListener('visibilitychange', visible);
	});
	$effect(() => {
		if (success) return;
		const expiries = (filesQuery.data ?? []).flatMap((file) =>
			file.expiresAt > now ? [file.expiresAt] : []
		);
		const boundary = Math.min(nextDelegationMidnight(now), ...expiries);
		const timer = setTimeout(refreshClock, Math.max(1, boundary - Date.now()));
		return () => clearTimeout(timer);
	});
	$effect(() => {
		const current = catalogData;
		if (frozen || success || current === undefined || catalogError) return;
		untrack(() => reconcileCatalog(current));
	});
	$effect(() => {
		const rows = filesQuery.data;
		const queryError = filesQuery.error;
		const timestamp = now;
		const currentUploads = uploads.map((upload) => ({ upload, uploadId: upload.uploadId }));
		if (!rows || queryError || success) return;
		untrack(() => {
			for (const { upload, uploadId } of currentUploads) {
				const row = rows.find((file) => file.uploadId === uploadId);
				if (row && row.expiresAt > timestamp && !upload.unavailable) {
					upload.confirmed = true;
					upload.error = '';
					if (upload.status !== 'removing') upload.status = 'uploaded';
					const attempt = reads.get(upload.uploadId);
					attempt?.confirm();
				} else if ((upload.confirmed || row) && !upload.unavailable) {
					upload.unavailable = true;
					upload.error = 'An attachment is unavailable. Remove it and upload it again.';
					if (upload.status !== 'removing') upload.status = 'error';
					if (!frozen) changed();
				}
			}
		});
	});
	function message(cause: unknown, fallback: string) {
		if (cause instanceof ConvexError) {
			if (typeof cause.data === 'string') return cause.data;
			if (cause.data && typeof cause.data === 'object' && 'message' in cause.data)
				return String(cause.data.message);
		}
		return cause instanceof Error ? cause.message : fallback;
	}
	async function discardDraft(id: string) {
		if (
			!id ||
			session.userId !== userId ||
			session.closing ||
			session.blocked ||
			viewer().membership.id !== membershipId
		)
			return;
		try {
			await client.mutation(api.delegation.discard, { membershipId, draftId: id });
		} catch (cause) {
			console.warn('Delegation attachment cleanup will retry through expiry.', cause);
		}
	}
	function clearDraft() {
		for (const { read } of reads.values()) read.abort();
		for (const read of removalReads) read.abort();
		reads.clear();
		void discardDraft(uploads.length ? draftId : '');
		draftId = '';
		uploads = [];
		uploadError = '';
	}
	function reconcileCatalog(current: Catalog | null) {
		if (current && appliedRevision !== undefined && current.revision <= appliedRevision) return;
		appliedRevision = current?.revision;
		if (!taskKey) return;
		const updated = current?.tasks.find((t) => t.key === taskKey);
		answers = Object.fromEntries(
			(updated?.questions ?? []).map((q) => [q.key, answers[q.key] ?? ''])
		);
		changed();
		if (!updated) {
			clearDraft();
			taskKey = '';
			step = 0;
		} else if (step === 2) step = 1;
	}
	onDestroy(() => {
		destroyed = true;
		for (const { read } of reads.values()) read.abort();
		for (const read of removalReads) read.abort();
		submitRead?.abort();
		const id = uploads.length ? draftId : '';
		if (pendingSubmission)
			void pendingSubmission.then(
				() => discardDraft(id),
				() => discardDraft(id)
			);
		else void discardDraft(id);
	});
	async function goTo(next: number) {
		if (locked || (next > 0 && !task) || (next === 2 && configuredRevision === null)) return;
		step = next;
		await tick();
		const header = document.getElementById(`${prefix}-step-${next}`);
		header?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
		header?.focus({ preventScroll: true });
	}
	function changed() {
		configuredRevision = null;
		error = '';
	}
	function selectTask(selected: Task) {
		if (locked) return;
		if (taskKey !== selected.key) {
			clearDraft();
			answers = Object.fromEntries(selected.questions.map((q) => [q.key, '']));
			changed();
		}
		taskKey = selected.key;
		void goTo(1);
	}
	function configure(event: SubmitEvent) {
		event.preventDefault();
		refreshClock();
		if (locked || !task || !catalog || uploadsPending) return;
		for (const question of task.questions) {
			if (question.required && !answers[question.key]?.trim()) {
				error = `Answer “${question.label}” before continuing.`;
				return;
			}
		}
		answers = Object.fromEntries(task.questions.map((q) => [q.key, answers[q.key] ?? '']));
		configuredRevision = catalog.revision;
		error = '';
		void goTo(2);
	}
	function chooseFiles(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = Array.from(input.files ?? []);
		input.value = '';
		if (locked || !canDispatch()) return;
		if (uploads.length + files.length > ATTACHMENT_MAX_COUNT) {
			uploadError = 'Attach up to three documents.';
			return;
		}
		uploadError = '';
		changed();
		for (const file of files) {
			if (!/\.(docx|pdf)$/i.test(file.name) || !file.size || file.size > ATTACHMENT_MAX_BYTES) {
				uploadError = 'Choose DOCX or PDF documents no larger than 10 MB each.';
				continue;
			}
			draftId ||= crypto.randomUUID();
			const key = crypto.randomUUID();
			uploads = [
				...uploads,
				{
					key,
					uploadId: key,
					file,
					confirmed: false,
					unavailable: false,
					status: 'uploading',
					error: ''
				}
			];
			void uploadFile(key);
		}
	}
	async function postFile(file: File, draft: string, uploadId: string, read: ReadAttempt) {
		const token = await waitForRead(
			clerk.session?.getToken({ template: 'convex' }) ?? Promise.resolve(null),
			read.signal
		);
		if (!canDispatch() || !token) throw new Error('Sign in again to upload your document.');
		const url = new URL(
			'/delegation-attachment',
			env.PUBLIC_CONVEX_URL!.replace('.convex.cloud', '.convex.site')
		);
		for (const [name, value] of Object.entries({
			membershipId,
			draftId: draft,
			uploadId,
			filename: file.name
		}))
			url.searchParams.set(name, value);
		const response = await waitForRead(
			fetch(url, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': /\.docx$/i.test(file.name) ? DOCX_CONTENT_TYPE : PDF_CONTENT_TYPE
				},
				body: file,
				signal: read.signal
			}),
			read.signal
		);
		const result: unknown = await waitForRead(response.json(), read.signal);
		if (!result || typeof result !== 'object')
			throw new Error('Unable to read the upload response. Try again.');
		if (!response.ok)
			throw new Error(
				'error' in result && typeof result.error === 'string'
					? result.error
					: 'Unable to upload this document. Try again.'
			);
		if (!('attachmentId' in result) || typeof result.attachmentId !== 'string')
			throw new Error('Unable to read the upload response. Try again.');
	}
	async function uploadFile(key: string) {
		const upload = uploads.find((u) => u.key === key);
		if (
			locked ||
			!upload ||
			!canDispatch() ||
			reads.has(upload.uploadId) ||
			removals.has(upload.uploadId)
		)
			return;
		if (upload.unavailable) {
			upload.uploadId = crypto.randomUUID();
			upload.confirmed = false;
			upload.unavailable = false;
		}
		const uploadId = upload.uploadId;
		const currentDraft = draftId;
		upload.status = 'uploading';
		upload.error = '';
		changed();
		const read = new ReadAttempt(60000);
		const confirmation = new Promise<void>((confirm) => {
			reads.set(uploadId, { read, confirm });
		});
		const current = () =>
			active() &&
			draftId === currentDraft &&
			uploads.some((u) => u.key === key && u.uploadId === uploadId);
		try {
			// Either path may arrive first; readiness always requires the live registration.
			await waitForRead(
				Promise.race([postFile(upload.file, currentDraft, uploadId, read), confirmation]),
				read.signal
			);
			await waitForRead(confirmation, read.signal);
		} catch (cause) {
			if (current() && !upload.confirmed) {
				upload.status = 'error';
				upload.error = read.signal.aborted
					? 'The upload timed out. Try again.'
					: message(cause, 'Unable to upload this document.');
			}
		} finally {
			read.abort();
			if (reads.get(uploadId)?.read === read) reads.delete(uploadId);
		}
	}
	async function removeFile(key: string) {
		if (locked || !canDispatch()) return;
		const source = uploads.find((u) => u.key === key);
		if (!source || source.status === 'uploading' || source.status === 'removing') return;
		const currentDraft = draftId;
		const uploadId = source.uploadId;
		const current = () =>
			active() &&
			draftId === currentDraft &&
			uploads.some((u) => u.key === key && u.uploadId === uploadId);
		source.status = 'removing';
		changed();
		let work = removals.get(uploadId);
		if (!work) {
			work = client.mutation(api.delegation.discard, {
				membershipId,
				draftId: currentDraft,
				uploadId
			});
			removals.set(uploadId, work);
			void work
				.then(
					() => {
						if (current()) {
							uploads = uploads.filter((u) => u.key !== key);
							changed();
							uploadError = '';
						}
					},
					(cause) => {
						if (current()) {
							source.status = source.confirmed && !source.unavailable ? 'uploaded' : 'error';
							uploadError = message(cause, 'Unable to remove this attachment. Try again.');
						}
					}
				)
				.finally(() => {
					if (removals.get(uploadId) === work) removals.delete(uploadId);
				});
		}
		const read = new ReadAttempt(30000);
		removalReads.add(read);
		try {
			await waitForRead(work, read.signal);
		} catch {
			if (current() && read.signal.aborted) {
				source.status = source.confirmed && !source.unavailable ? 'uploaded' : 'error';
				uploadError = 'Unable to remove this attachment. Try again.';
			}
		} finally {
			read.complete();
			removalReads.delete(read);
		}
	}
	function startSubmission() {
		const attempt = frozen!;
		const work = client.mutation(api.delegation.submit, {
			membershipId,
			operationId: attempt.operationId,
			payload: attempt.payload
		});
		pendingSubmission = work;
		void work
			.then(
				(result) => {
					if (!active() || frozen?.operationId !== attempt.operationId) return;
					success = result;
					delegateName = attempt.catalog.delegate.name;
					frozen = null;
					saving = false;
					error = '';
				},
				(cause) => {
					if (!active() || frozen?.operationId !== attempt.operationId) return;
					if (
						cause instanceof ConvexError &&
						cause.data &&
						typeof cause.data === 'object' &&
						'definitive' in cause.data &&
						cause.data.definitive === true
					) {
						frozen = null;
						configuredRevision = null;
						step = 1;
						if (
							'code' in cause.data &&
							cause.data.code === 'STALE_CATALOG' &&
							'catalog' in cause.data
						) {
							// This snapshot comes from the rejecting transaction, not a cached client query.
							const snapshot = cause.data.catalog as Catalog | null;
							onCatalogRejected(snapshot);
							reconcileCatalog(snapshot);
						}
					}
					error = message(
						cause,
						'Unable to confirm your submission. Retry to check the same request.'
					);
					saving = false;
				}
			)
			.finally(() => {
				if (pendingSubmission === work) pendingSubmission = undefined;
			});
		return work;
	}
	async function submit() {
		refreshClock();
		if (saving || success || !canDispatch() || !task || !catalog) return;
		if (!frozen && (configuredRevision !== catalog.revision || uploadsPending)) {
			configuredRevision = null;
			step = 1;
			error = 'Review your answers and continue again.';
			return;
		}
		if (!frozen) {
			draftId ||= crypto.randomUUID();
			frozen = {
				operationId: crypto.randomUUID(),
				catalog,
				payload: {
					draftId,
					catalogRevision: configuredRevision!,
					taskKey,
					answers: { ...answers },
					attachmentIds: attached.flatMap((u) => (u.attachmentId ? [u.attachmentId] : []))
				}
			};
		}
		saving = true;
		error = '';
		const read = new ReadAttempt(30000);
		submitRead = read;
		try {
			await waitForRead(pendingSubmission ?? startSubmission(), read.signal);
		} catch {
			if (active() && frozen && read.signal.aborted)
				error = 'We couldn’t confirm the submission. Retry to check and save the same request.';
		} finally {
			read.complete();
			if (submitRead === read) submitRead = undefined;
			if (active()) saving = false;
		}
	}
</script>

<ModalShell
	title="Delegate a task"
	variant="panel"
	position="right"
	maxWidth={640}
	contentPadding={28}
	{onClose}
>
	{#if success}
		<div
			class="flex flex-col items-start gap-4 rounded-[10px] border-hairline border-edge bg-surface p-[22px] shadow-card"
			role="status"
		>
			<CheckCircleIcon size={32} weight="regular" aria-hidden="true" />
			<div>
				<h3 class="text-[16px] font-medium">Task delegated</h3>
				<p class="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
					{delegateName} will take care of your task by {formatDelegationDeadline(success.dueDate)}.
				</p>
			</div>
			<Button variant="secondary" class="w-full" onclick={onClose}>Done</Button>
		</div>
	{:else if !frozen && (catalogError || catalogData === null)}
		<p class="py-4 text-[12.5px] text-ink-muted" role="alert">
			Unable to load the tasks. Close this window and try again.
		</p>
	{:else if !catalog}
		<p class="py-4 text-[12.5px] text-ink-muted" role="status">Loading tasks…</p>
	{:else}
		<div class="space-y-4">
			{#each steps as title, index}
				{@const disabled =
					locked || (index > 0 && !task) || (index === 2 && configuredRevision === null)}
				<section
					class="rounded-[10px] border-hairline border-edge bg-surface shadow-card"
					class:opacity-45={!locked && disabled}
				>
					<h3>
						<button
							type="button"
							id={`${prefix}-step-${index}`}
							class="flex w-full items-center gap-3 rounded-[10px] p-[18px] text-left text-[14px] font-medium outline-offset-2 focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default"
							aria-expanded={step === index}
							aria-controls={`${prefix}-panel-${index}`}
							{disabled}
							onclick={() => goTo(index)}
						>
							<span
								class="grid size-[18px] shrink-0 place-items-center rounded-full bg-ink text-[10px] font-light text-white"
								aria-hidden="true">{index + 1}</span
							>{title}
						</button>
					</h3>
					{#if step === index}
						<div id={`${prefix}-panel-${index}`} class="px-[18px] pb-[18px]">
							{#if index === 0}
								<div class="mb-5 flex items-start gap-3 rounded-lg border-hairline border-line p-4">
									<Avatar
										name={catalog.delegate.name}
										avatarUrl={catalog.delegate.avatarPath}
										size={40}
										decorative
									/>
									<div class="min-w-0">
										<p class="text-[12.5px] font-medium">{catalog.delegate.name}</p>
										<p class="mt-1 text-[12.5px] leading-[1.5] text-ink-muted">
											{catalog.delegate.introduction}
										</p>
									</div>
								</div>
								<div
									class={`${fieldShellClass} mb-3 flex h-9 items-center gap-2`}
									aria-disabled={locked}
								>
									<MagnifyingGlassIcon
										class="shrink-0 text-ink-muted"
										size={16}
										aria-hidden="true"
									/>
									<input
										bind:this={searchInput}
										class={fieldInputClass}
										type="search"
										aria-label="Search tasks"
										placeholder="Search tasks"
										bind:value={search}
										disabled={locked}
									/>
									{#if search}
										<button
											type="button"
											aria-label="Clear search"
											class="-mr-1 flex size-6 shrink-0 items-center justify-center rounded-button-sm text-ink-muted transition-colors not-disabled:hover:bg-control-fill not-disabled:hover:text-ink focus-visible:outline-1 focus-visible:outline-line-strong/40"
											disabled={locked}
											onclick={() => {
												search = '';
												searchInput?.focus();
											}}
										>
											<XIcon size={14} weight="regular" aria-hidden="true" />
										</button>
									{/if}
								</div>
								<div
									class="divide-y-[length:var(--surface-border-width)] divide-line overflow-hidden rounded-lg border-hairline border-line"
								>
									{#each visibleTasks as option}
										<button
											type="button"
											class="flex w-full items-center gap-3 p-[18px] text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
											onclick={() => selectTask(option)}
											disabled={locked}
										>
											<p class="min-w-0 flex-1 truncate text-[12.5px] font-medium">
												{option.title}
											</p>
											<CaretRightIcon
												size={15}
												class="shrink-0 text-ink-muted"
												aria-hidden="true"
											/>
										</button>
									{:else}<p class="p-4 text-[12.5px] text-ink-muted">
											No tasks match your search.
										</p>{/each}
								</div>
							{:else if index === 1 && task}
								<form class="space-y-5" onsubmit={configure}>
									<div>
										<p class="text-[12.5px] font-medium">{task.title}</p>
										<p class="mt-2 text-[12.5px] leading-relaxed text-ink-muted">
											{task.description}
										</p>
									</div>
									{#each task.questions as question}
										<div>
											<label
												for={`${prefix}-${question.key}`}
												class="mb-2 block text-[12.5px] leading-relaxed"
												>{question.label}{#if !question.required}<span class="text-ink-muted">
														(optional)</span
													>{/if}</label
											>
											{#if question.kind === 'text'}
												<input
													id={`${prefix}-${question.key}`}
													class={`${fieldClass} h-10`}
													required={question.required}
													maxlength={10000}
													disabled={locked}
													bind:value={answers[question.key]}
													oninput={changed}
												/>
											{:else}
												<textarea
													id={`${prefix}-${question.key}`}
													class={`${fieldClass} min-h-24 py-2.5 leading-[1.45]`}
													rows={3}
													required={question.required}
													maxlength={10000}
													disabled={locked}
													bind:value={answers[question.key]}
													oninput={changed}></textarea>
											{/if}
										</div>
									{/each}
									<div>
										<p class="mb-2 text-[12.5px]">
											Attachments <span class="text-ink-muted">(optional)</span>
										</p>
										<input
											bind:this={fileInput}
											type="file"
											accept=".docx,.pdf"
											multiple
											class="hidden"
											aria-label="Attach documents"
											onchange={chooseFiles}
											disabled={locked}
										/>
										<Button
											variant="secondary"
											class="w-full"
											disabled={locked || uploads.length >= ATTACHMENT_MAX_COUNT}
											onclick={() => fileInput?.click()}
											><PaperclipIcon size={16} aria-hidden="true" />Attach documents</Button
										>
										<p class="mt-2 text-[12px] text-ink-muted">
											Up to 3 DOCX or PDF files, 10 MB each.
										</p>
										{#each attached as upload (upload.key)}
											<div
												class="mt-2 flex items-start gap-2 rounded-lg border-hairline border-line p-3.5"
											>
												<FileTextIcon size={16} class="mt-0.5 shrink-0" aria-hidden="true" />
												<div class="min-w-0 flex-1">
													<p class="truncate text-[12px]">{upload.file.name}</p>
													<p class="mt-1 text-[12px] text-ink-muted" role="status">
														{upload.status === 'uploading'
															? 'Uploading…'
															: upload.status === 'removing'
																? 'Removing…'
																: upload.attachmentId
																	? 'Attached'
																	: upload.error}
													</p>
													{#if upload.status === 'error' && !upload.attachmentId}<button
															type="button"
															class="mt-1 text-[12px] underline"
															onclick={() => uploadFile(upload.key)}>Retry upload</button
														>{/if}
												</div>
												<button
													type="button"
													class="rounded p-1 text-ink-muted not-disabled:hover:bg-control-fill"
													aria-label={`Remove ${upload.file.name}`}
													disabled={locked ||
														upload.status === 'uploading' ||
														upload.status === 'removing'}
													onclick={() => removeFile(upload.key)}
													><XIcon size={14} aria-hidden="true" /></button
												>
											</div>
										{/each}
										{#if uploadError}<p class="mt-2 text-[12.5px] text-red-700" role="alert">
												{uploadError}
											</p>{/if}
									</div>
									{#if error}<p class="text-[12.5px] text-red-700" role="alert">{error}</p>{/if}
									<Button
										type="submit"
										variant="primary"
										class="w-full"
										disabled={locked || uploadsPending}>Continue</Button
									>
								</form>
							{:else if index === 2 && task}
								<div class="space-y-5">
									<p class="text-[12.5px] font-medium">{task.title}</p>
									<dl class="space-y-3">
										{#each task.questions as question}{#if answers[question.key]?.trim()}<div>
													<dt class="text-[12px] text-ink-muted">{question.label}</dt>
													<dd class="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed">
														{answers[question.key]}
													</dd>
												</div>{/if}{/each}
									</dl>
									{#if attached.length}<div>
											<p class="text-[12px] text-ink-muted">Attachments</p>
											{#each attached as upload}<p class="mt-1 truncate text-[12.5px]">
													{upload.file.name}
												</p>{/each}
										</div>{/if}
									<p class="text-[12.5px] leading-relaxed text-ink-muted">
										{catalog.delegate.name} will take care of your task within {task.businessDays} business
										days. Expected by
										<span class="text-ink">{formatDelegationDeadline(preview)}</span>.
									</p>
									{#if error}<p class="text-[12.5px] text-red-700" role="alert">{error}</p>{/if}
									<Button variant="primary" class="w-full" disabled={saving} onclick={submit}
										>{saving
											? 'Delegating…'
											: frozen
												? 'Retry delegation'
												: 'Delegate task'}</Button
									>
								</div>
							{/if}
						</div>
					{/if}
				</section>
			{/each}
		</div>
	{/if}
</ModalShell>
