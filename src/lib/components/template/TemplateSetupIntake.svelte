<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import type { FunctionArgs } from 'convex/server';
	import { useConvexClient } from 'convex-svelte';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { api } from '../../../convex/_generated/api';
	import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
	import AuthButton from '$lib/auth/components/AuthButton.svelte';
	import AuthTextInput from '$lib/auth/components/AuthTextInput.svelte';
	import TextArea from '$lib/ui/TextArea.svelte';
	import { saveError } from '$lib/contract/saved';
	import { SETUP_INTAKE_MAX_COUNT, SETUP_INTAKE_MAX_TEXT_LENGTH } from '$lib/template/setup-intake';

	type SaveIntakeInput = Omit<FunctionArgs<typeof api.templateSetup.saveIntake>, 'membershipId'>;

	let {
		membershipId,
		step,
		disabled = false
	}: {
		membershipId: Id<'memberships'>;
		step: 'team' | 'negotiation';
		disabled?: boolean;
	} = $props();

	const client = useConvexClient();
	const id = $props.id();

	let reps = $state('');
	let csms = $state('');
	let acvBuckets = $state('');
	let negotiationSystem = $state('');
	let repError = $state('');
	let csmError = $state('');
	let submitError = $state('');
	let saving = $state(false);
	let negotiationInput = $state<HTMLTextAreaElement>();
	let generation = 0;
	let attempt: ReadAttempt | undefined;

	function cancel() {
		generation++;
		attempt?.abort();
		attempt = undefined;
	}
	onDestroy(cancel);

	onMount(() => {
		if (step === 'negotiation' && !disabled && negotiationInput && !negotiationInput.value)
			negotiationInput.focus();
	});

	function parseOptionalCount(raw: string): { ok: true; value?: number } | { ok: false } {
		const trimmed = raw.trim();
		if (!trimmed) return { ok: true };
		if (!/^\d+$/.test(trimmed)) return { ok: false };
		const value = Number(trimmed);
		return value <= SETUP_INTAKE_MAX_COUNT ? { ok: true, value } : { ok: false };
	}

	async function submitTeam() {
		if (saving || disabled) return;
		repError = '';
		csmError = '';
		submitError = '';

		const parsedReps = parseOptionalCount(reps);
		const parsedCsms = parseOptionalCount(csms);
		if (!parsedReps.ok) repError = 'Enter a whole number.';
		if (!parsedCsms.ok) csmError = 'Enter a whole number.';
		if (!parsedReps.ok || !parsedCsms.ok) return;

		const trimmedAcvBuckets = acvBuckets.trim();
		await save({
			step: 'team',
			...(parsedReps.value !== undefined ? { repCount: parsedReps.value } : {}),
			...(parsedCsms.value !== undefined ? { csmCount: parsedCsms.value } : {}),
			...(trimmedAcvBuckets ? { acvBuckets: trimmedAcvBuckets } : {})
		});
	}

	async function submitNegotiation() {
		if (saving || disabled) return;
		submitError = '';
		const trimmed = negotiationSystem.trim();
		await save({
			step: 'negotiation',
			...(trimmed ? { negotiationSystem: trimmed } : {})
		});
	}

	async function save(args: SaveIntakeInput) {
		cancel();
		const current = generation;
		const read = new ReadAttempt(15_000);
		attempt = read;
		saving = true;
		try {
			await waitForRead(
				client.mutation(api.templateSetup.saveIntake, { membershipId, ...args }),
				read.signal
			);
		} catch (cause) {
			if (generation === current) {
				submitError = read.signal.aborted
					? 'Saving took too long. Please try again.'
					: saveError(cause, 'Unable to save your answers. Please try again.');
			}
		} finally {
			read.complete();
			if (generation === current) {
				saving = false;
				attempt = undefined;
			}
		}
	}
</script>

<div class="pt-1 pb-2">
	{#if step === 'team'}
		<form
			class="grid gap-4 text-left"
			novalidate
			onsubmit={(event) => {
				event.preventDefault();
				void submitTeam();
			}}
		>
			<div>
				<AuthTextInput
					id={id + '-reps'}
					label="How many Sales Reps are in your company?"
					visibleLabel
					placeholder="Optional"
					bind:value={reps}
					inputmode="numeric"
					maxlength={7}
					autofocus
					invalid={Boolean(repError)}
					describedby={repError ? id + '-reps-error' : undefined}
					disabled={saving || disabled}
					oninput={() => {
						repError = '';
						submitError = '';
					}}
				/>
				{#if repError}
					<p id={id + '-reps-error'} role="alert" class="mt-1.5 text-xs leading-5 text-danger">
						{repError}
					</p>
				{/if}
			</div>

			<div>
				<AuthTextInput
					id={id + '-csms'}
					label="How many Customer Success Managers are in your company?"
					visibleLabel
					placeholder="Optional"
					bind:value={csms}
					inputmode="numeric"
					maxlength={7}
					invalid={Boolean(csmError)}
					describedby={csmError ? id + '-csms-error' : undefined}
					disabled={saving || disabled}
					oninput={() => {
						csmError = '';
						submitError = '';
					}}
				/>
				{#if csmError}
					<p id={id + '-csms-error'} role="alert" class="mt-1.5 text-xs leading-5 text-danger">
						{csmError}
					</p>
				{/if}
			</div>

			<label class="block min-w-0">
				<span class="mb-2 block text-[13px] font-[450] text-ink">
					What are the buckets of ACV for the deals your team sells?
				</span>
				<TextArea
					id={id + '-acv-buckets'}
					bind:value={acvBuckets}
					rows={2}
					maxlength={SETUP_INTAKE_MAX_TEXT_LENGTH}
					placeholder="Optional"
					disabled={saving || disabled}
					oninput={() => (submitError = '')}
					class="min-h-14"
				/>
			</label>

			{#if submitError}
				<p role="alert" class="m-0 text-center text-sm leading-5 text-danger">{submitError}</p>
			{/if}

			<div class="pt-1">
				<AuthButton type="submit" disabled={saving || disabled}>
					{saving ? 'Saving…' : 'Continue'}
				</AuthButton>
			</div>
		</form>
	{:else}
		<form
			class="grid gap-4 text-left"
			novalidate
			onsubmit={(event) => {
				event.preventDefault();
				void submitNegotiation();
			}}
		>
			<label class="block min-w-0">
				<span class="mb-2 block text-[13px] font-[450] text-ink">
					Do you already have a system to help reps negotiate contracts?
				</span>
				<TextArea
					id={id + '-negotiation'}
					bind:element={negotiationInput}
					bind:value={negotiationSystem}
					rows={6}
					maxlength={SETUP_INTAKE_MAX_TEXT_LENGTH}
					placeholder="Optional"
					disabled={saving || disabled}
					oninput={() => (submitError = '')}
					class="min-h-40"
				/>
			</label>

			{#if submitError}
				<p role="alert" class="m-0 text-center text-sm leading-5 text-danger">{submitError}</p>
			{/if}

			<div class="pt-1">
				<AuthButton type="submit" disabled={saving || disabled}>
					{saving ? 'Saving…' : 'Continue'}
				</AuthButton>
			</div>
		</form>
	{/if}
</div>
