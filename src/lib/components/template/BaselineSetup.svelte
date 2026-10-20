<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import { useViewer, useViewerSession } from '$lib/auth/viewer-session.svelte';
	import AppHeader from '$lib/components/chrome/AppHeader.svelte';
	import InfoBar from '$lib/components/ui/InfoBar.svelte';
	import FileTextIcon from 'phosphor-svelte/lib/FileTextIcon';
	import CheckCircleIcon from 'phosphor-svelte/lib/CheckCircleIcon';
	import WarningCircleIcon from 'phosphor-svelte/lib/WarningCircleIcon';
	import type { BaselineBlock } from '$lib/contract/source-model';
	import { DOCX_MAX_BYTES, type ImportIssue } from '$lib/contract/import/limits';
	import { saveError } from '$lib/contract/saved';
	let { getNavigationIntent }: { getNavigationIntent: () => number } = $props();
	const viewer = useViewer();
	const session = useViewerSession();
	const client = useConvexClient();
	const membershipId = viewer().membership.id;
	const admin = $derived(viewer().profile.role === 'admin');
	let fileInput = $state<HTMLInputElement>();
	let fileName = $state('');
	let blocks = $state.raw<BaselineBlock[]>([]);
	let issues = $state.raw<ImportIssue[]>([]);
	let parsing = $state(false);
	let publishing = $state(false);
	let confirmed = $state(false);
	let uploadError = $state('');
	let publishError = $state('');
	let dragDepth = $state(0);
	let generation = 0;
	let worker: Worker | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const errors = $derived(issues.filter((i) => i.severity === 'error'));
	const blocked = $derived(errors.length > 0);
	const ready = $derived(blocks.length > 0 && !blocked && !parsing);
	const dragging = $derived(dragDepth > 0 && !publishing);
	function findText(context: string) {
		const text = context.replace(/\s+/g, ' ').trim();
		return text.length > 100 ? `${text.slice(0, 100).trimEnd()}…` : text;
	}
	function cancel() {
		generation++;
		worker?.terminate();
		worker = undefined;
		clearTimeout(timeout);
	}
	onDestroy(cancel);
	function resetUpload(name = '') {
		cancel();
		blocks = [];
		issues = [];
		confirmed = false;
		uploadError = '';
		publishError = '';
		fileName = name;
		parsing = false;
	}
	function chooseFile() {
		if (!fileInput || publishing) return;
		fileInput.value = '';
		fileInput.click();
	}
	function selectFiles(files: FileList | null) {
		if (!files?.length || !admin || publishing) return;
		if (files.length !== 1) {
			resetUpload();
			uploadError = 'Upload one Word contract at a time.';
			return;
		}
		void upload(files[0]);
	}
	function dragEnter(event: DragEvent) {
		if (!event.dataTransfer?.types.includes('Files')) return;
		event.preventDefault();
		if (!publishing) dragDepth++;
	}
	function dragOver(event: DragEvent) {
		event.preventDefault();
		if (event.dataTransfer) event.dataTransfer.dropEffect = publishing ? 'none' : 'copy';
	}
	function drop(event: DragEvent) {
		event.preventDefault();
		dragDepth = 0;
		selectFiles(event.dataTransfer?.files ?? null);
	}
	async function upload(file: File) {
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
		try {
			const data = await file.arrayBuffer();
			if (generation !== current) return;
			worker = new Worker(new URL('../../contract/import/worker.ts', import.meta.url), {
				type: 'module'
			});
			// Worker construction and parser loading happen only after a file is selected.
			worker.onmessage = (
				event: MessageEvent<{
					error?: string;
					result?: {
						blocks: BaselineBlock[];
						issues: ImportIssue[];
					};
				}>
			) => {
				if (generation !== current) return;
				if (event.data.error) uploadError = event.data.error;
				else if (event.data.result) {
					blocks = event.data.result.blocks;
					issues = event.data.result.issues;
				}
				parsing = false;
				worker?.terminate();
				worker = undefined;
				clearTimeout(timeout);
			};
			worker.onerror = () => {
				if (generation === current) {
					uploadError = 'Unable to read this Word file. Save it again in Word and re-upload.';
					parsing = false;
					cancel();
				}
			};
			timeout = setTimeout(() => {
				if (generation === current) {
					cancel();
					parsing = false;
					uploadError = 'The Word file took too long to read. Simplify it and upload again.';
				}
			}, 30000);
			worker.postMessage(data, [data]);
		} catch (cause) {
			if (generation === current) {
				cancel();
				parsing = false;
				uploadError = cause instanceof Error ? cause.message : 'Unable to read this file.';
			}
		}
	}
	async function publish() {
		if (
			!admin ||
			parsing ||
			blocked ||
			!confirmed ||
			publishing ||
			!blocks.length ||
			session.closing
		)
			return;
		publishing = true;
		publishError = '';
		const intent = getNavigationIntent();
		const route = page.url.href;
		const userId = session.userId;
		const prepared = session.prepared;
		const transportGeneration = session.transportGeneration;
		try {
			await client.mutation(api.templates.publishBaseline, { membershipId, blocks });
			if (
				getNavigationIntent() !== intent ||
				page.url.href !== route ||
				session.closing ||
				session.userId !== userId ||
				session.prepared !== prepared ||
				session.transportGeneration !== transportGeneration ||
				viewer().membership.id !== membershipId
			)
				return;
			await goto('/admin');
		} catch (cause) {
			publishError =
				cause &&
				typeof cause === 'object' &&
				'data' in cause &&
				cause.data &&
				typeof cause.data === 'object' &&
				'message' in cause.data &&
				typeof cause.data.message === 'string'
					? cause.data.message
					: saveError(cause, 'Unable to publish the baseline. Try again.');
		} finally {
			publishing = false;
		}
	}
</script>

<AppHeader />
<main
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-[#fafafa] px-5 pt-10 pb-12 sm:px-6 sm:pt-16 sm:pb-16"
>
	<div class="mx-auto max-w-[1262px]">
		<div class="mx-auto mb-9 max-w-[440px] text-center">
			<h1 class="text-[18px] leading-8 font-medium tracking-[-0.025em] text-ink">
				Set up your company’s contract
			</h1>
			<p class="mt-1 text-[13px] leading-6 text-ink-muted">
				{#if admin}
					Upload the Word contract your team uses as the starting point for every new contract.
				{:else}
					Your team can start creating contracts once an admin uploads and publishes your company’s
					starting contract.
				{/if}
			</p>
		</div>

		<div class="mx-auto max-w-[780px]">
			{#if admin}
				<input
					bind:this={fileInput}
					type="file"
					accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
					aria-label="Choose a Word contract"
					class="hidden"
					onchange={(event) => selectFiles(event.currentTarget.files)}
					disabled={publishing}
				/>
				<section
					aria-label="Upload Word contract"
					class={[
						'group relative flex min-h-[283px] flex-col items-center justify-center rounded-2xl px-5 py-8 text-center transition-colors motion-reduce:transition-none sm:px-10',
						dragging
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
							stroke="var(--color-line)"
							stroke-width="1"
							stroke-dasharray="7 5"
							class={[
								'transition-colors motion-reduce:transition-none group-hover:stroke-ink-muted/30 group-focus-within:stroke-ink-muted/30',
								dragging && 'stroke-ink-muted/30'
							]}
						/>
					</svg>
					<h2 class="w-full text-[14px] leading-6 font-medium text-ink [overflow-wrap:anywhere]">
						{dragging ? 'Drop your Word contract here' : fileName || 'Drop your Word contract here'}
					</h2>
					<p role="status" class="mt-1.5 text-[13px] leading-5 text-ink-muted">
						{#if publishing}
							Publishing your contract…
						{:else if parsing}
							Checking your document…
						{:else if uploadError}
							Choose a new file to try again.
						{:else if blocked}
							A few corrections are needed before publishing.
						{:else if ready}
							File checked and ready to publish.
						{:else}
							Or choose a Word file from your computer.
						{/if}
					</p>
					<button
						type="button"
						class="mt-5 cursor-pointer rounded-full bg-accent px-5 py-2.5 text-[13px] font-medium text-white ring-4 ring-transparent transition-[background-color,box-shadow,filter] duration-100 ease-out enabled:hover:bg-accent-hover enabled:active:brightness-90 enabled:active:ring-accent/20 enabled:active:duration-0 motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent disabled:cursor-default disabled:opacity-40"
						onclick={chooseFile}
						disabled={publishing}>{fileName ? 'Choose another file' : 'Choose a Word file'}</button
					>
					<p class="mt-3 text-xs leading-5 text-ink-muted">Upload a .docx</p>
				</section>
			{:else}
				<section
					aria-labelledby="waiting-for-contract"
					class="flex min-h-[250px] flex-col items-center justify-center rounded-base border border-line bg-surface px-6 py-10 text-center"
				>
					<div
						class="mb-4 flex size-11 items-center justify-center rounded-button-xl bg-canvas text-ink-muted"
						aria-hidden="true"
					>
						<FileTextIcon size={22} />
					</div>
					<h2 id="waiting-for-contract" class="text-[14px] leading-6 font-medium text-ink">
						Waiting for your company’s contract
					</h2>
					<p class="mt-1 max-w-[360px] text-[13px] leading-6 text-ink-muted">
						Contact an admin on your company team to finish setup.
					</p>
				</section>
			{/if}

			<InfoBar
				class="mt-4"
				label={admin ? 'This is the first step.' : 'Your admin needs to finish setup.'}
			>
				{#if admin}
					Upload the baseline contract you use with customers as a first step to get started.
				{:else}
					Ask an admin to upload and publish your company’s starting contract.
				{/if}
			</InfoBar>

			{#if admin}
				{#if uploadError}
					<p
						role="alert"
						class="mt-4 rounded-button-xl border border-danger/20 bg-danger-surface px-5 py-4 text-[13px] leading-6 text-danger"
					>
						{uploadError}
					</p>
				{/if}

				{#if blocked}
					<section
						aria-labelledby="contract-corrections"
						role="alert"
						class="mt-5 rounded-base border border-line bg-surface p-5 sm:p-6"
					>
						<div class="flex items-start gap-3">
							<WarningCircleIcon size={22} class="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
							<div>
								<h2 id="contract-corrections" class="text-sm leading-6 font-medium text-ink">
									{errors.length === 1 ? 'One correction' : `${errors.length} corrections`} before publishing
								</h2>
								<p class="mt-1 text-[13px] leading-6 text-ink-muted">
									Make {errors.length === 1 ? 'this correction' : 'these corrections'} in Word, save the
									file, and upload it again.
								</p>
							</div>
						</div>
						<ul class="mt-5 divide-y divide-line/70 border-t border-line/70 text-[13px] leading-6">
							{#each errors as issue}
								<li class="py-4 last:pb-0">
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

				{#if ready}
					<section
						aria-labelledby="contract-ready"
						class="mt-5 rounded-base border border-line bg-surface p-5 sm:p-6"
					>
						<div class="flex items-start gap-3">
							<CheckCircleIcon size={22} class="mt-0.5 shrink-0 text-success" aria-hidden="true" />
							<div>
								<h2 id="contract-ready" class="text-sm leading-6 font-medium text-ink">
									Ready to publish
								</h2>
								<p class="mt-1 text-[13px] leading-6 text-ink-muted">
									Publish this contract, then add instructions to guide your team.
								</p>
							</div>
						</div>
						<label
							class="mt-5 flex cursor-pointer items-start gap-3 rounded-button-lg border border-line/70 bg-[#fafafa] p-4 text-[13px] leading-6 text-ink-secondary"
						>
							<input
								class="mt-1 size-4 shrink-0 cursor-pointer accent-ink focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent disabled:cursor-default"
								type="checkbox"
								bind:checked={confirmed}
								disabled={publishing}
							/>
							<span
								>I understand this will be my team’s permanent starting contract and can’t be
								replaced.</span
							>
						</label>
						<button
							type="button"
							class="mt-5 cursor-pointer rounded-button-lg bg-[#171717] px-5 py-2.5 text-[13px] font-medium text-white transition-colors hover:bg-[#303030] focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-accent disabled:cursor-default disabled:opacity-40"
							disabled={!confirmed || publishing || session.closing}
							onclick={publish}>{publishing ? 'Publishing…' : 'Publish contract'}</button
						>
						{#if publishError}
							<p role="alert" class="mt-3 text-[13px] leading-6 text-danger">{publishError}</p>
						{/if}
					</section>
				{/if}
			{/if}
		</div>
	</div>
</main>
