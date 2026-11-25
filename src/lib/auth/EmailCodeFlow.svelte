<script lang="ts">
	import RouteTitle from './RouteTitle.svelte';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { AccountNavigation } from './account-navigation';
	import { useClerkReadiness } from './clerk-readiness';
	import { beginStartupAttempt, recordStartup } from './startup-perf';
	import { page } from '$app/state';
	import { useClerkContext, useSignIn, useSignUp } from 'svelte-clerk';
	import { createAccountDestination, isAccountEntryPath, localReturn } from './navigation';
	import AuthCodeStep from './components/AuthCodeStep.svelte';
	import { useEntryPresentation } from './entry-presentation.svelte';
	import AuthHotkeyButton from './components/AuthHotkeyButton.svelte';
	import AuthStepFrame from './components/AuthStepFrame.svelte';
	import AuthTextInput from './components/AuthTextInput.svelte';
	import { createClerkEmailCodeAuthController, getClerkErrorCode } from './email-code-auth';
	import { useStartupPreparation } from './startup-preparation';
	import { preloadDestination } from './destination-code';
	import { useViewerSession } from './viewer-session.svelte';
	import LoadingState from '$lib/ui/LoadingState.svelte';

	type EntryStep = 'email' | 'code';
	type Props =
		| { mode: 'login'; invitation?: never }
		| { mode: 'create-account'; invitation?: never }
		| { mode: 'invitation'; invitation: { email: string; companyName: string } };

	let props: Props = $props();
	const creatingAccount = $derived(props.mode === 'create-account');
	const invitation = $derived(props.mode === 'invitation' ? props.invitation : undefined);
	const presentation = useEntryPresentation();
	const clerk = useClerkContext();
	const session = useViewerSession();
	const readiness = useClerkReadiness();
	const preparation = useStartupPreparation();
	const sessionEnding = $derived(
		Boolean(
			session &&
			(session.closing ||
				session.phase === 'signing-out' ||
				session.phase === 'completing-deletion')
		)
	);
	const activeSessionId = $derived(sessionEnding ? undefined : clerk.session?.id);
	const navigation = new AccountNavigation(async (destination) => {
		recordStartup('navigation-started');
		await goto(destination, { invalidateAll: true });
		if (isAccountEntryPath(page.url.pathname)) throw new Error('Navigation returned to log in.');
		recordStartup('navigation-completed');
	});
	let opening = $state(false);
	let hydrated = $state(false);
	let lifetime = new AbortController();
	let observedSession: string | undefined;
	let navigatingSession: string | undefined;
	const returnTo = $derived(
		invitation
			? page.url.pathname + page.url.search
			: localReturn(page.url.searchParams.get('returnTo'))
	);
	const entryDestination = $derived(
		creatingAccount ? createAccountDestination(returnTo) : returnTo
	);
	const authTicket = $derived(page.url.searchParams.get('__clerk_ticket'));
	$effect(() => {
		const id = activeSessionId;
		const destination = entryDestination;
		untrack(() => {
			if (id === observedSession) return;
			observedSession = id;
			if (id && !invitation) void openDestination(id, destination);
			else if (id) recordStartup('auth-accepted');
			else showEmailStep();
		});
	});
	async function openDestination(id: string, destination: string) {
		if (opening && navigatingSession === id) return;
		const verifying = isSubmittingCode || isSubmittingEmail;
		cancelPending();
		const current = generation;
		navigatingSession = id;
		opening = true;
		authErrorText = null;
		if (!verifying) beginStartupAttempt();
		recordStartup('auth-accepted');
		// Clerk owns the token cache; the destination requests this same session's token.
		void clerk.session?.getToken({ template: 'convex' }).catch(() => {});
		try {
			await navigation.open(id, destination);
		} catch {
			if (current === generation) authErrorText = 'We couldn’t open this page. Try again.';
		} finally {
			if (current === generation) {
				opening = false;
				navigatingSession = undefined;
			}
		}
	}
	let ticketStarted = $state(false);
	$effect(() => {
		const ticket = authTicket;
		if (
			ticket &&
			!ticketStarted &&
			!clerk.session &&
			readiness.status === 'ready' &&
			(creatingAccount ? signUpState.signUp : signInState.signIn)
		) {
			ticketStarted = true;
			void acceptTicket(ticket);
		}
	});
	async function acceptTicket(ticket: string) {
		const current = ++generation;
		isSubmittingEmail = true;
		beginStartupAttempt();
		try {
			if (!(await waitForAuth(current))) return;
			prepareDestination();
			if (creatingAccount) await authController.acceptCreateAccountTicket(ticket);
			else await authController.acceptLoginTicket(ticket);
		} catch (error) {
			if (current === generation) {
				preparation.cancel();
				authErrorText = authController.getErrorMessage(error);
			}
		} finally {
			if (current === generation) isSubmittingEmail = false;
		}
	}

	const signUpState = useSignUp();
	const signInState = useSignIn();
	const authController = createClerkEmailCodeAuthController({
		getSignIn: () => signInState.signIn,
		getSignUp: () => signUpState.signUp
	});

	let generation = 0;
	function cancelPending() {
		generation++;
		lifetime.abort();
		lifetime = new AbortController();
		authController.reset();
		navigation.reset();
		navigatingSession = undefined;
		opening = false;
		isSubmittingEmail = false;
		isSubmittingCode = false;
		isResendingCode = false;
	}
	onMount(() => {
		hydrated = true;
		recordStartup('entry-hydrated');
	});
	onDestroy(() => {
		cancelPending();
		lifetime.abort();
		if (!activeSessionId) preparation.cancel();
	});

	let step = $state<EntryStep>('email');
	let email = $state(untrack(() => (props.mode === 'invitation' ? props.invitation.email : '')));
	let verificationCode = $state('');
	let authErrorText = $state<string | null>(null);
	let isSubmittingEmail = $state(false);
	let isSubmittingCode = $state(false);
	let isResendingCode = $state(false);
	const ticketPending = $derived(
		Boolean(authTicket) &&
			!clerk.session &&
			(!ticketStarted || isSubmittingEmail) &&
			readiness.status !== 'error'
	);

	const canContinue = $derived(
		hydrated && email.trim().length > 0 && !isSubmittingEmail && !opening
	);
	async function waitForAuth(current: number) {
		await readiness.ready({ signal: lifetime.signal });
		await tick();
		if (current !== generation || opening || clerk.session) return false;
		if (
			invitation
				? !signInState.signIn || !signUpState.signUp
				: !(creatingAccount ? signUpState.signUp : signInState.signIn)
		)
			throw new Error('Log in is unavailable. Please try again.');
		return true;
	}
	async function retry() {
		authErrorText = null;
		try {
			await readiness.retry();
		} catch {
			/* The provider exposes the inline connection error. */
		}
	}

	async function submitEmail() {
		const normalizedEmail = (invitation?.email ?? email).trim().toLowerCase();
		if (!normalizedEmail || isSubmittingEmail || opening || readiness.status === 'error') return;

		const current = ++generation;
		isSubmittingEmail = true;
		authErrorText = null;
		verificationCode = '';

		try {
			if (!(await waitForAuth(current))) return;
			// A Clerk ticket is consumed by its own serialized operation.
			if (authTicket && !ticketStarted) return;
			prepareDestination();
			if (invitation) await authController.sendInvitationCode(normalizedEmail);
			else if (creatingAccount) await authController.sendCreateAccountCode(normalizedEmail);
			else await authController.sendLoginCode(normalizedEmail);
			if (current !== generation) return;
			email = normalizedEmail;
			step = 'code';
		} catch (error) {
			if (current !== generation) return;
			preparation.cancel();
			authErrorText =
				getClerkErrorCode(error) === 'form_identifier_not_found'
					? 'Couldn’t find your account.'
					: authController.getErrorMessage(error);
		} finally {
			if (current === generation) isSubmittingEmail = false;
		}
	}

	async function submitCode() {
		const code = verificationCode.trim();
		if (!code || isSubmittingCode || opening) return;

		const current = generation;
		isSubmittingCode = true;
		authErrorText = null;
		beginStartupAttempt();
		recordStartup('code-submitted');

		try {
			if (!(await waitForAuth(current))) return;
			await authController.verifyCode(code);
		} catch (error) {
			if (current !== generation) return;
			authErrorText = authController.getErrorMessage(error);
		} finally {
			if (current === generation) isSubmittingCode = false;
		}
	}

	async function resendCode() {
		if (isResendingCode || opening) return;

		const current = generation;
		isResendingCode = true;
		authErrorText = null;

		try {
			if (!(await waitForAuth(current))) return;
			await authController.resendCode();
		} catch (error) {
			if (current !== generation) return;
			authErrorText = authController.getErrorMessage(error);
		} finally {
			if (current === generation) isResendingCode = false;
		}
	}

	function showEmailStep() {
		cancelPending();
		preparation.cancel();
		verificationCode = '';
		authErrorText = null;
		step = 'email';
	}

	$effect(() => {
		presentation.showFooter = !invitation && step === 'email' && !opening && !ticketPending;
		presentation.createAccountStep =
			creatingAccount && !authTicket && !activeSessionId ? (step === 'code' ? 2 : 1) : undefined;
		return () => {
			presentation.showFooter = true;
			presentation.createAccountStep = undefined;
		};
	});

	function prepareDestination() {
		preparation.warm();
		const pathname = new URL(entryDestination, page.url).pathname;
		void preloadDestination(pathname).catch(() => {});
	}
</script>

<RouteTitle
	title={step === 'code'
		? 'Enter your verification code'
		: invitation
			? `Join ${invitation.companyName}`
			: creatingAccount
				? 'Create account'
				: 'Log in'}
/>

{#if opening || ticketPending}
	<LoadingState
		label={opening
			? 'Opening your account'
			: creatingAccount
				? 'Creating your account'
				: 'Logging in'}
	/>
{:else}
	{#if activeSessionId}
		<AuthStepFrame title="Continue to Dinu">
			{#if authErrorText}
				<p role="alert" class="m-0 text-sm leading-5 text-danger">{authErrorText}</p>
			{/if}
			<AuthHotkeyButton onclick={() => void openDestination(activeSessionId, entryDestination)}>
				Try again
			</AuthHotkeyButton>
		</AuthStepFrame>
	{:else if step === 'email'}
		<AuthStepFrame
			title={invitation ? 'Welcome to Dinu' : creatingAccount ? 'Create account' : 'Log in to Dinu'}
			description={invitation
				? `You’ll be joining ${invitation.companyName}’s workspace and we’ll create your account if you don’t have one yet.`
				: undefined}
		>
			<form
				class="grid gap-3.5"
				onsubmit={(event) => {
					event.preventDefault();
					if (canContinue) {
						void submitEmail();
					}
				}}
			>
				{#if !invitation}
					<AuthTextInput
						label="Your work email"
						bind:value={email}
						type="email"
						autocomplete="email"
						required
						autofocus
						invalid={Boolean(authErrorText)}
					/>
				{/if}
				{#if readiness.error || authErrorText}
					<p role="alert" class="m-0 text-sm leading-5 text-danger">
						{readiness.error || authErrorText}
					</p>
				{/if}
				{#if readiness.status === 'error'}
					<button type="button" class="text-sm underline" onclick={() => void retry()}
						>Try again</button
					>
				{/if}
				<AuthHotkeyButton type="submit" disabled={!canContinue || readiness.status === 'error'}>
					{isSubmittingEmail
						? readiness.status === 'ready'
							? 'Sending…'
							: 'Connecting…'
						: 'Email me a code'}
				</AuthHotkeyButton>
			</form>
		</AuthStepFrame>
	{:else}
		<AuthCodeStep
			{email}
			bind:code={verificationCode}
			errorText={authErrorText}
			isSubmitting={isSubmittingCode}
			isResending={isResendingCode}
			onSubmit={() => void submitCode()}
			onResend={() => void resendCode()}
			onChangeEmail={invitation ? undefined : showEmailStep}
		/>
	{/if}
{/if}

<!-- Keep the host mounted while Clerk waits for an account-creation challenge. -->
{#if creatingAccount || invitation}
	<div
		id="clerk-captcha"
		class="flex justify-center"
		data-cl-theme="light"
		data-cl-size="compact"
		data-cl-language="auto"
	></div>
{/if}
