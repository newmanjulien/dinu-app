<script lang="ts">
	import { fieldClass } from '$lib/ui/field-styles';
	import { onDestroy } from 'svelte';
	import type { SessionResource, UserResource } from '@clerk/shared/types';
	import { useClerkContext } from 'svelte-clerk';
	import { useConvexClient, useQuery } from 'convex-svelte';
	import type { FunctionReturnType } from 'convex/server';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import {
		createClerkSessionVerification,
		type ClerkSessionVerificationFactor,
		getErrorMessage,
		isReverificationRequiredError
	} from '$lib/auth/clerk-session-verification.svelte';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { Button, destructiveButtonClass, ModalShell } from '$lib/ui';

	type ModalStep = 'confirmDeletion' | 'verifyIdentity';

	type Props = {
		open: boolean;
		onClose: () => void;
	};

	let { open, onClose }: Props = $props();
	const clerk = useClerkContext();
	const client = useConvexClient();
	const viewerSession = useViewerSession();
	const options = useQuery(api.accountDeletion.options, () => (open ? {} : 'skip'));
	const combined = $derived(options.data?.mode === 'accountAndCompany');
	const confirmationPhrase = $derived(
		combined ? 'delete my account and company' : 'delete my account'
	);
	const deletionTitle = $derived(combined ? 'Delete account and company' : 'Delete account');
	const verification = createClerkSessionVerification({
		isCurrent: (session) =>
			attempt !== null && attempt.sessionId === session.id && isCurrent(attempt),
		onComplete: async () => {
			const a = attempt;
			if (a) await executeDeletion(a, true);
		}
	});
	type Attempt = {
		user: UserResource;
		session: SessionResource;
		userId: string;
		sessionId: string;
		generation: number;
		mode: 'account' | 'accountAndCompany';
		companyId: Id<'company'> | null;
		confirmation: string;
		attemptId: string;
		request: FunctionReturnType<typeof api.accountDeletion.prepare>;
	};
	let attempt: Attempt | null = null;
	let generation = 0;
	let alive = true;
	let contextKey = '';
	onDestroy(() => {
		alive = false;
		resetModalState();
	});

	let step = $state<ModalStep>('confirmDeletion');
	let confirmationText = $state('');
	let deleteErrorText = $state<string | null>(null);
	let deleting = $state(false);
	let lastOpen = $state(false);

	const trimmedConfirmationText = $derived(confirmationText.trim());
	const canDeleteAccount = $derived(
		Boolean(options.data && options.data.mode !== 'transferOwnership') &&
			trimmedConfirmationText === confirmationPhrase
	);
	const errorText = $derived(
		step === 'confirmDeletion'
			? (deleteErrorText ??
					(options.error
						? getErrorMessage(options.error, 'Unable to check company membership.')
						: null))
			: verification.errorText
	);
	const verificationTitle = $derived(getVerificationTitle(verification.factor));
	const verificationDescription = $derived(getVerificationDescription(verification.factor));
	const verificationInputType = $derived(
		verification.factor?.strategy === 'password' ? 'password' : 'text'
	);
	const verificationAutocomplete = $derived(
		verification.factor?.strategy === 'password' ? 'current-password' : 'one-time-code'
	);
	const verificationInputMode = $derived(getVerificationInputMode(verification.factor));
	const showVerificationInput = $derived(
		verification.factor !== null && verification.factor.strategy !== 'passkey'
	);
	const showPasskeyPrompt = $derived(
		verification.factor?.strategy === 'passkey' && verification.status === 'awaitingInput'
	);
	const verificationActionText = $derived(getVerificationActionText());

	$effect(() => {
		const key = `${clerk.user?.id ?? ''}:${clerk.session?.id ?? ''}`;
		if (open !== lastOpen || key !== contextKey) {
			resetModalState();
		}
		contextKey = key;
		lastOpen = open;
	});

	function resetModalState() {
		const old = attempt;
		if (old?.request?.status === 'prepared') void cancelPreparation(old).catch(() => {});
		generation++;
		attempt = null;
		confirmationText = '';
		deleteErrorText = null;
		deleting = false;
		step = 'confirmDeletion';
		verification.reset();
	}

	async function closeDeleteModal() {
		if (deleting) {
			return;
		}

		const context = {
			generation,
			userId: clerk.user?.id ?? '',
			sessionId: clerk.session?.id ?? ''
		};
		if (options.data?.pending || attempt?.request) {
			deleting = true;
			try {
				// Explicit cancellation revokes the current preparation across tabs.
				const outcome = await client.mutation(api.accountDeletion.cancel, {});
				if (!isCurrent(context)) return;
				if (outcome === 'dispatched')
					throw new Error(
						'Account deletion has already been dispatched. Retry deletion to finish.'
					);
			} catch (error) {
				if (!isCurrent(context)) return;
				returnToConfirmationWithError(
					getErrorMessage(error, 'Unable to cancel company deletion. Try again.')
				);
				deleting = false;
				return;
			}
		}
		onClose();
		resetModalState();
	}

	function getVerificationTitle(factor: ClerkSessionVerificationFactor | null) {
		if (!factor) {
			return 'Verify your identity';
		}

		switch (factor.strategy) {
			case 'password':
				return 'Enter your password';
			case 'email_code':
				return 'Enter the email code';
			case 'phone_code':
				return 'Enter the phone code';
			case 'totp':
				return 'Enter your authenticator code';
			case 'backup_code':
				return 'Enter a backup code';
			case 'passkey':
				return 'Verify with your passkey';
		}
	}

	function getVerificationDescription(factor: ClerkSessionVerificationFactor | null) {
		if (!factor) {
			return 'Verify your identity before deleting this account.';
		}

		if (
			(factor.strategy === 'email_code' || factor.strategy === 'phone_code') &&
			factor.safeIdentifier
		) {
			return `Enter the verification code sent to ${factor.safeIdentifier}.`;
		}

		if (factor.strategy === 'passkey') {
			return 'Use your passkey to verify your identity.';
		}

		return 'Verify your identity before deleting this account.';
	}

	function getVerificationInputMode(factor: ClerkSessionVerificationFactor | null) {
		switch (factor?.strategy) {
			case 'email_code':
			case 'phone_code':
			case 'totp':
				return 'numeric';
			case 'backup_code':
				return 'text';
			case 'password':
			case 'passkey':
			case undefined:
				return undefined;
		}
	}

	function getVerificationActionText() {
		if (verification.status === 'preparing') {
			return 'Preparing...';
		}

		if (verification.status === 'verifying') {
			return 'Verifying...';
		}

		return verification.factor?.strategy === 'passkey'
			? 'Verify with passkey'
			: 'Verify and delete';
	}

	function isCurrent(a: Pick<Attempt, 'generation' | 'userId' | 'sessionId'>) {
		return (
			alive &&
			open &&
			generation === a.generation &&
			clerk.user?.id === a.userId &&
			clerk.session?.id === a.sessionId
		);
	}

	function getDeletionContext() {
		if (!clerk.isLoaded || !clerk.user || !clerk.session) {
			return {
				ok: false,
				errorText: 'Unable to delete your account right now.'
			} as const;
		}

		if (!clerk.user.deleteSelfEnabled) {
			return {
				ok: false,
				errorText: 'Account deletion is unavailable right now. Please try again later.'
			} as const;
		}

		return {
			ok: true,
			user: clerk.user,
			session: clerk.session,
			userId: clerk.user.id,
			sessionId: clerk.session.id,
			generation
		} as const;
	}

	function returnToConfirmationWithError(message: string) {
		step = 'confirmDeletion';
		verification.reset();
		deleteErrorText = message;
	}
	async function cancelPreparation(a: Attempt) {
		const request = a.request;
		if (request?.status !== 'prepared') return;
		const outcome = await client.mutation(api.accountDeletion.cancel, {
			request: { id: request.id, attemptId: request.attemptId }
		});
		if (outcome === 'cancelled' || outcome === 'none') a.request = null;
	}

	async function executeDeletion(a: Attempt, afterVerification = false) {
		if (!isCurrent(a)) return;
		deleteErrorText = null;
		deleting = true;
		try {
			if (a.mode === 'accountAndCompany')
				a.request = await client.mutation(api.accountDeletion.prepare, {
					protocol: 'dispatch',
					mode: a.mode,
					companyId: a.companyId,
					confirmation: a.confirmation,
					attemptId: a.request?.attemptId ?? a.attemptId
				});
			if (!isCurrent(a)) {
				await cancelPreparation(a);
				return;
			}
			a.request = await client.mutation(api.accountDeletion.dispatch, {
				mode: a.mode,
				companyId: a.companyId,
				confirmation: a.confirmation,
				attemptId: a.request?.attemptId ?? a.attemptId,
				requestId: a.request?.id ?? null
			});
			if (!isCurrent(a)) return;
			await a.user.delete();
			viewerSession.completeAccountDeletion({ sessionId: a.sessionId, userId: a.userId });
			if (!isCurrent(a)) return;
			onClose();
			resetModalState();
		} catch (error) {
			const needsVerification = isReverificationRequiredError(error);
			// Conditional cancellation cannot revoke a dispatch whose reply was lost.
			// Verification and uncertain Clerk failures retain dispatched consent.
			try {
				await cancelPreparation(a);
			} catch {
				/* Unused preparations expire. */
			}
			if (!isCurrent(a)) return;
			deleting = false;
			if (needsVerification && !afterVerification) {
				step = 'verifyIdentity';
				await verification.start(a.session);
				if (!isCurrent(a)) return;
			} else {
				returnToConfirmationWithError(
					needsVerification
						? 'Identity verification is still required before deleting this account. Please try again.'
						: getErrorMessage(error, 'Unable to delete your account.')
				);
			}
		}
	}

	async function deleteAccount() {
		if (!canDeleteAccount || deleting || verification.busy) return;
		generation++;
		const context = getDeletionContext();
		if (!context.ok) {
			returnToConfirmationWithError(context.errorText);
			return;
		}
		const selection = options.data;
		if (!selection || selection.mode === 'transferOwnership') return;
		attempt = {
			...context,
			mode: selection.mode,
			companyId: selection.companyId,
			confirmation: trimmedConfirmationText,
			attemptId: crypto.randomUUID(),
			request: null
		};
		await executeDeletion(attempt);
	}
</script>

<ModalShell {open} title={deletionTitle} dismissible={!deleting} onClose={closeDeleteModal}>
	<div class="space-y-4">
		{#if step === 'confirmDeletion'}
			{#if !options.data && !options.error}
				<p class="text-sm leading-6 text-ink-secondary">Checking company membership...</p>
			{:else if options.data?.mode === 'transferOwnership'}
				<p class="text-sm leading-6 text-ink-secondary">
					Transfer ownership of {options.data.companyName ?? 'your company'} to a colleague before deleting
					your account.
					<a href="/team" class="underline" onclick={() => onClose()}>Open the team page</a>
				</p>
			{:else if options.data}
				<p class="text-sm leading-6 text-ink-secondary">
					{#if combined}
						You are the last member of <strong>{options.data.companyName}</strong>. This permanently
						deletes your account and company, including all contracts, the playbook, templates and
						their history, approval records, invitations, and the company avatar. This cannot be
						undone.
					{:else}
						This permanently deletes your account. Company contracts and other shared data remain
						available to your colleagues.
					{/if}
				</p>
				{#if options.data.pending}
					<p class="text-sm leading-6 text-ink-secondary">
						Company activity is paused while account deletion is confirmed. You can retry deletion
						or cancel it here.
					</p>
				{/if}
				<div>
					<label for="delete-account-confirmation" class="block text-xs text-ink">
						Type <strong>"{confirmationPhrase}"</strong> to continue
					</label>
					<input
						id="delete-account-confirmation"
						type="text"
						bind:value={confirmationText}
						autocomplete="off"
						class={`${fieldClass} mt-2 h-9`}
						disabled={deleting}
						oninput={() => {
							deleteErrorText = null;
						}}
					/>
				</div>
			{/if}
		{:else}
			<div>
				<h3 class="text-sm leading-tight font-medium text-ink">
					{verificationTitle}
				</h3>
				<p class="mt-2 text-sm leading-6 text-ink-secondary">
					{verificationDescription}
				</p>
			</div>

			{#if verification.status === 'preparing'}
				<p class="text-[0.72rem] leading-5 text-ink-muted">Preparing verification...</p>
			{:else if showVerificationInput}
				<div>
					<label for="delete-account-verification" class="block text-xs text-ink">
						{verificationTitle}
					</label>
					<input
						id="delete-account-verification"
						type={verificationInputType}
						bind:value={verification.input}
						autocomplete={verificationAutocomplete}
						inputmode={verificationInputMode}
						class={`${fieldClass} mt-2 h-9`}
						disabled={verification.busy || deleting}
						oninput={() => {
							verification.clearError();
						}}
					/>
				</div>
			{:else if showPasskeyPrompt}
				<p class="text-[0.72rem] leading-5 text-ink-muted">
					Continue with the passkey prompt to verify your identity.
				</p>
			{/if}
		{/if}

		{#if errorText}
			<p class="text-[0.72rem] leading-5 text-danger">{errorText}</p>
		{/if}
	</div>

	{#snippet footer()}
		{#if step === 'confirmDeletion'}
			<Button variant="secondary" disabled={deleting} onclick={closeDeleteModal}>Cancel</Button>
			<Button
				disabled={!canDeleteAccount || deleting || verification.busy}
				class={destructiveButtonClass}
				onclick={deleteAccount}
			>
				{deleting ? 'Deleting...' : deletionTitle}
			</Button>
		{:else}
			<Button variant="secondary" disabled={deleting} onclick={closeDeleteModal}>Cancel</Button>
			<Button
				disabled={!verification.canSubmit || deleting || verification.busy}
				class={destructiveButtonClass}
				onclick={verification.submit}
			>
				{deleting ? 'Deleting...' : verificationActionText}
			</Button>
		{/if}
	{/snippet}
</ModalShell>
