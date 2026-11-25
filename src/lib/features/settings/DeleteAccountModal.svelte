<script lang="ts">
	import TextInput from '$lib/ui/TextInput.svelte';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import { useReadQuery } from '$lib/auth/read-query.svelte';
	import { onDestroy } from 'svelte';
	import type { SessionResource } from '@clerk/shared/types';
	import { useClerkContext } from 'svelte-clerk';
	import { useConvexClient } from 'convex-svelte';
	import { api } from '../../../convex/_generated/api';
	import type { Id } from '../../../convex/_generated/dataModel';
	import { getErrorMessage, isAccountDeletedError } from '$lib/auth/account-errors';
	import {
		createClerkSessionVerification,
		type ClerkSessionVerificationFactor,
		needsStrictReverification
	} from '$lib/auth/clerk-session-verification.svelte';
	import { useViewerSession } from '$lib/auth/viewer-session.svelte';
	import { Button, ModalShell } from '$lib/ui';

	type ModalStep = 'confirmDeletion' | 'verifyIdentity';

	type Props = {
		open: boolean;
		retryHold?: boolean;
		onClose: () => void;
	};

	let { open, retryHold = false, onClose }: Props = $props();
	const clerk = useClerkContext();
	const client = useConvexClient();
	const viewerSession = useViewerSession();
	let step = $state<ModalStep>('confirmDeletion');
	let confirmationText = $state('');
	let deleteErrorText = $state<string | null>(null);
	let deleting = $state(false);
	let lastOpen = false;

	const options = useReadQuery(api.accountDeletion.options, () => (open ? {} : 'skip'));
	type Attempt = {
		session: SessionResource;
		userId: string;
		sessionId: string;
		generation: number;
		mode: 'account' | 'accountAndCompany';
		companyId: Id<'company'>;
		companyName: string;
		confirmation: string;
		retryHold: boolean;
	};
	let attempt = $state.raw<Attempt | null>(null);
	const activeOptions = $derived(
		options.data ??
			(deleting && attempt
				? {
						mode: attempt.mode,
						companyId: attempt.companyId,
						companyName: attempt.companyName,
						hold: attempt.retryHold ? ('deleting' as const) : ('none' as const)
					}
				: undefined)
	);
	const optionsError = $derived(
		deleting ||
			viewerSession.phase === 'completing-deletion' ||
			viewerSession.closing ||
			isAccountDeletedError(options.error)
			? undefined
			: options.error
	);
	const combined = $derived(activeOptions?.mode === 'accountAndCompany');
	const cleaning = $derived(
		activeOptions?.hold === 'cleaning' || (!deleting && activeOptions?.hold === 'inProgress')
	);
	const retryingHold = $derived(Boolean(retryHold && activeOptions?.hold === 'deleting'));
	const confirmationPhrase = $derived(
		combined ? 'delete my account and company' : 'delete my account'
	);
	const deletionTitle = $derived(
		retryingHold
			? 'Retry account and company deletion'
			: combined
				? 'Delete account and company'
				: 'Delete account'
	);
	const verification = createClerkSessionVerification({
		isCurrent: (session) =>
			attempt !== null && attempt.sessionId === session.id && isCurrent(attempt),
		onComplete: async () => {
			const a = attempt;
			if (a) await executeDeletion(a, true);
		}
	});
	let generation = 0;
	let alive = true;
	let contextKey = '';
	onDestroy(() => {
		alive = false;
		resetModalState();
	});

	const trimmedConfirmationText = $derived(confirmationText.trim());
	const blockedByOwnership = $derived(activeOptions?.mode === 'transferOwnership');
	const canDeleteAccount = $derived(
		Boolean(activeOptions && !blockedByOwnership && !cleaning) &&
			(retryingHold || trimmedConfirmationText === confirmationPhrase)
	);
	const errorText = $derived(
		step === 'confirmDeletion'
			? (deleteErrorText ??
					(optionsError
						? getErrorMessage(optionsError, 'Unable to check company membership.')
						: null))
			: verification.errorText
	);
	const verificationTitle = $derived(getVerificationTitle(verification.factor));
	const isEmailVerification = $derived(verification.factor?.strategy === 'email_code');
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
	const canRestartVerification = $derived(
		step === 'verifyIdentity' &&
			verification.status === 'idle' &&
			verification.factor === null &&
			!deleting &&
			attempt !== null
	);

	$effect(() => {
		const key = `${clerk.user?.id ?? ''}:${clerk.session?.id ?? ''}`;
		if (open !== lastOpen || key !== contextKey) {
			resetModalState();
		}
		contextKey = key;
		lastOpen = open;
	});

	function resetModalState() {
		generation++;
		attempt = null;
		confirmationText = '';
		deleteErrorText = null;
		deleting = false;
		step = 'confirmDeletion';
		verification.reset();
	}

	function closeDeleteModal() {
		if (deleting) return;
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

		if (clerk.session.actor) {
			return {
				ok: false,
				errorText: 'Account deletion is unavailable while impersonating a user.'
			} as const;
		}

		return {
			ok: true,
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

	async function startVerification(a: Attempt) {
		if (!isCurrent(a)) return;
		step = 'verifyIdentity';
		await verification.start(a.session);
	}

	async function executeDeletion(a: Attempt, afterVerification = false) {
		if (!isCurrent(a)) return;
		deleteErrorText = null;
		deleting = true;
		try {
			const sessionToken = await a.session.getToken({ skipCache: true });
			if (!isCurrent(a)) return;
			if (!sessionToken) {
				deleting = false;
				if (!afterVerification) {
					await startVerification(a);
					return;
				}
				returnToConfirmationWithError('Unable to verify your session. Please try again.');
				return;
			}
			const result = await client.action(api.accountDeletionActions.execute, {
				mode: a.mode,
				companyId: a.companyId,
				confirmation: a.confirmation,
				sessionToken,
				retryHold: a.retryHold || undefined
			});
			if (!isCurrent(a)) return;
			if (result.status === 'reverificationRequired') {
				deleting = false;
				if (!afterVerification) {
					await startVerification(a);
					return;
				}
				returnToConfirmationWithError(
					'Identity verification is still required before deleting this account. Please try again.'
				);
				return;
			}
			await viewerSession.completeAccountDeletion({
				sessionId: a.sessionId,
				userId: a.userId
			});
			if (!isCurrent(a)) return;
			onClose();
			resetModalState();
		} catch (error) {
			if (!isCurrent(a) || viewerSession.phase === 'completing-deletion' || viewerSession.closing)
				return;
			deleting = false;
			returnToConfirmationWithError(getErrorMessage(error, 'Unable to delete your account.'));
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
		if (
			!selection ||
			selection.mode === 'transferOwnership' ||
			selection.hold === 'cleaning' ||
			selection.hold === 'inProgress'
		)
			return;
		attempt = {
			...context,
			mode: selection.mode,
			companyId: selection.companyId,
			companyName: selection.companyName,
			confirmation: retryingHold ? '' : trimmedConfirmationText,
			retryHold: retryingHold
		};
		if (needsStrictReverification(attempt.session)) {
			await startVerification(attempt);
			return;
		}
		await executeDeletion(attempt, false);
	}
</script>

<ModalShell {open} title={deletionTitle} dismissible={!deleting} onClose={closeDeleteModal}>
	<div class="space-y-4">
		{#if step === 'confirmDeletion'}
			{#if !activeOptions && !optionsError}
				<span role="status" class="sr-only">Checking company membership</span>
				<div aria-hidden="true" class="grid gap-2 py-1">
					<SkeletonBlock class="h-4 w-full" />
					<SkeletonBlock class="h-4 w-full" />
					<SkeletonBlock class="h-4 w-3/4" />
				</div>
			{:else if optionsError}
				<p role="alert" class="text-sm">
					We couldn’t check company membership. <button
						class="underline"
						onclick={() => options.retry()}>Try again</button
					>
				</p>
			{:else if blockedByOwnership && activeOptions}
				<p class="text-sm leading-6 text-ink-secondary">
					Transfer ownership of {activeOptions.companyName} to a colleague before deleting your account.
					<a href="/team" class="underline" onclick={() => closeDeleteModal()}>Open the team page</a
					>
				</p>
			{:else if cleaning}
				<p class="text-sm leading-6 text-ink-secondary">
					Company deletion is already in progress. Workspace activity is paused while cleanup
					finishes.
				</p>
			{:else if activeOptions}
				<p class="text-sm leading-6 text-ink-secondary">
					{#if retryingHold}
						Your previous deletion attempt for <strong class="font-medium text-ink"
							>{activeOptions.companyName}</strong
						> could not be confirmed. Continue below to permanently delete your account and company.
					{:else if combined}
						You are the last member of <strong class="font-medium text-ink"
							>{activeOptions.companyName}</strong
						>. This permanently deletes your account and company, including all contracts, your
						company’s template, rep instructions, buyer explanations, their history, approval
						records, invitations, and the company avatar. This cannot be undone.
					{:else}
						This permanently deletes your account. Company contracts and other shared data remain
						available to your colleagues.
					{/if}
				</p>
				{#if !retryingHold}
					<div>
						<label for="delete-account-confirmation" class="block text-xs text-ink">
							Type <strong class="font-semibold">"{confirmationPhrase}"</strong> to continue
						</label>
						<TextInput
							id="delete-account-confirmation"
							type="text"
							bind:value={confirmationText}
							autocomplete="off"
							class="mt-2"
							disabled={deleting}
							oninput={() => {
								deleteErrorText = null;
							}}
							onkeydown={(event) => {
								if (event.key === 'Enter' && canDeleteAccount && !deleting && !verification.busy) {
									event.preventDefault();
									void deleteAccount();
								}
							}}
						/>
					</div>
				{/if}
			{/if}
		{:else}
			<div>
				{#if !isEmailVerification}
					<h3 class="text-sm leading-tight font-medium text-ink">
						{verificationTitle}
					</h3>
				{/if}
				<p class="text-sm leading-6 text-ink-secondary" class:mt-2={!isEmailVerification}>
					{verificationDescription}
				</p>
			</div>

			{#if showVerificationInput}
				<div>
					<label
						for="delete-account-verification"
						class={isEmailVerification ? 'sr-only' : 'block text-xs text-ink'}
					>
						{verificationTitle}
					</label>
					<TextInput
						id="delete-account-verification"
						type={verificationInputType}
						bind:value={verification.input}
						autocomplete={verificationAutocomplete}
						inputmode={verificationInputMode}
						class={isEmailVerification ? undefined : 'mt-2'}
						disabled={verification.busy || deleting}
						oninput={() => {
							verification.clearError();
						}}
						onkeydown={(event) => {
							if (
								event.key === 'Enter' &&
								verification.canSubmit &&
								!deleting &&
								!verification.busy
							) {
								event.preventDefault();
								void verification.submit();
							}
						}}
					/>
					{#if verification.canResend || verification.resending}
						<div class="mt-2 flex items-center justify-between gap-2 text-xs text-ink-muted">
							<span>{verification.resendNotice ?? 'Didn’t receive a code?'}</span>
							<button
								type="button"
								class="cursor-pointer underline underline-offset-2 hover:text-ink disabled:cursor-default disabled:text-ink-muted"
								disabled={!verification.canResend}
								onclick={() => void verification.resend()}
							>
								{verification.resending ? 'Sending...' : 'Resend code'}
							</button>
						</div>
					{/if}
				</div>
			{:else if showPasskeyPrompt}
				<p class="text-[0.72rem] leading-5 text-ink-muted">
					Continue with the passkey prompt to verify your identity.
				</p>
			{/if}
		{/if}

		{#if errorText}
			<p role="alert" class="text-[0.72rem] leading-5 text-danger">{errorText}</p>
		{/if}
	</div>

	{#snippet footer()}
		{#if step === 'confirmDeletion'}
			{#if blockedByOwnership || cleaning}
				<Button variant="secondary" disabled={deleting} onclick={closeDeleteModal}>Close</Button>
			{:else}
				<Button variant="secondary" disabled={deleting} onclick={closeDeleteModal}>Cancel</Button>
				<Button
					disabled={!canDeleteAccount || deleting || verification.busy}
					class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
					onclick={deleteAccount}
				>
					{deleting ? 'Deleting...' : retryingHold ? 'Retry deletion' : deletionTitle}
				</Button>
			{/if}
		{:else}
			<Button variant="secondary" disabled={deleting} onclick={closeDeleteModal}>Cancel</Button>
			{#if canRestartVerification}
				<Button
					class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
					onclick={() => attempt && void startVerification(attempt)}
				>
					Try again
				</Button>
			{:else}
				<Button
					disabled={!verification.canSubmit || deleting || verification.busy}
					class="bg-danger text-white not-disabled:not-aria-disabled:hover:bg-danger-hover"
					onclick={verification.submit}
				>
					{deleting ? 'Deleting...' : verificationActionText}
				</Button>
			{/if}
		{/if}
	{/snippet}
</ModalShell>
