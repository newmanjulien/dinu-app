<script lang="ts">
	import RouteTitle from './RouteTitle.svelte';
	import { onDestroy, onMount, tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { AccountNavigation } from './account-navigation';
	import { useClerkReadiness } from './clerk-readiness';
	import { beginStartupAttempt, recordStartup } from './startup-perf';
	import { page } from '$app/state';
	import { useClerkContext } from 'svelte-clerk';
	import { localReturn, onboardingHref } from './navigation';
	import { useSignIn, useSignUp } from 'svelte-clerk';
	import AuthCodeStep from '$lib/auth/components/AuthCodeStep.svelte';
	import { useEntryPresentation } from './entry-presentation.svelte';
	import AuthHotkeyButton from '$lib/auth/components/AuthHotkeyButton.svelte';
	import AuthStepFrame from '$lib/auth/components/AuthStepFrame.svelte';
	import AuthTextInput from '$lib/auth/components/AuthTextInput.svelte';
	import { createClerkEmailCodeAuthController, getClerkErrorCode } from '$lib/auth/email-code-auth';
	import { useStartupPreparation } from './startup-preparation';
	import { preloadDestination } from './destination-code';
	import LoadingState from '$lib/ui/LoadingState.svelte';

	type LoginStep = 'login' | 'code';

	let {
		joining = false,
		invitation
	}: { joining?: boolean; invitation?: { email: string; companyName: string } } = $props();
	const presentation = useEntryPresentation();
	const clerk = useClerkContext();
	const readiness = useClerkReadiness();
	const preparation = useStartupPreparation();
	const navigation = new AccountNavigation(async (destination) => {
		recordStartup('navigation-started');
		await goto(destination, { invalidateAll: true });
		if (page.url.pathname === '/login' || page.url.pathname === '/join')
			throw new Error('Navigation returned to sign-in.');
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
	const entryDestination = $derived.by(() => {
		if (!joining || invitation) return returnTo;
		const pathname = new URL(returnTo, page.url).pathname;
		return ['/onboarding', '/invitation'].includes(pathname) ? returnTo : onboardingHref(returnTo);
	});
	const authTicket = $derived(page.url.searchParams.get('__clerk_ticket'));
	$effect(() => {
		const id = clerk.session?.id;
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
			(joining ? signUpState.signUp : signInState.signIn)
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
			if (joining) await authController.acceptTicket(ticket);
			else await authController.acceptSignInTicket(ticket);
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
		recordStartup('sign-in-hydrated');
	});
	onDestroy(() => {
		cancelPending();
		lifetime.abort();
		if (!clerk.session) preparation.cancel();
	});

	let step = $state<LoginStep>('login');
	let email = $state(untrack(() => invitation?.email ?? ''));
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

	const joinHref = $derived(
		(joining ? '/login' : '/join') + '?returnTo=' + encodeURIComponent(returnTo)
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
				: !(joining ? signUpState.signUp : signInState.signIn)
		)
			throw new Error('Sign-in is unavailable. Please try again.');
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
			else if (joining) await authController.sendJoinCode(normalizedEmail);
			else await authController.sendLoginCode(normalizedEmail);
			if (current !== generation) return;
			email = normalizedEmail;
			step = 'code';
		} catch (error) {
			if (current !== generation) return;
			preparation.cancel();
			authErrorText =
				getClerkErrorCode(error) === 'form_identifier_not_found'
					? "Couldn't find your account."
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
		step = 'login';
	}

	$effect(() => {
		presentation.footer = accountFooter;
		presentation.showFooter = !invitation && step === 'login' && !opening && !ticketPending;
		return () => {
			if (presentation.footer === accountFooter) {
				presentation.footer = undefined;
				presentation.showFooter = true;
			}
		};
	});

	function prepareDestination() {
		preparation.warm();
		const pathname = new URL(entryDestination, page.url).pathname;
		void preloadDestination(pathname).catch(() => {});
	}
</script>

<RouteTitle
	title={`${step === 'code' ? 'Enter your code' : invitation ? `Join ${invitation.companyName}` : joining ? 'Join' : 'Log in'} | Dinu`}
/>

{#snippet accountFooter()}
	<p class="m-0 text-[13px] leading-5 text-ink-muted">
		{joining ? 'Already have an account?' : 'Need an account?'}
		<a
			href={joinHref}
			class="text-ink-muted underline underline-offset-2 transition-colors hover:text-ink"
		>
			{joining ? 'Log in' : 'Join'}
		</a>
	</p>
{/snippet}

{#if opening || ticketPending}
	<LoadingState label={opening ? 'Opening your account' : 'Signing in'} />
{:else}
	{#if clerk.session}
		<AuthStepFrame title="Continue to Dinu">
			{#if authErrorText}
				<p role="alert" class="m-0 text-sm leading-5 text-danger">{authErrorText}</p>
			{/if}
			<AuthHotkeyButton onclick={() => void openDestination(clerk.session!.id, entryDestination)}>
				Try again
			</AuthHotkeyButton>
		</AuthStepFrame>
	{:else if step === 'login'}
		<AuthStepFrame
			title={invitation
				? `Join ${invitation.companyName}`
				: joining
					? 'Join Dinu'
					: 'Log in to Dinu'}
			description={invitation
				? 'Verify your invited email to continue. We’ll create your Dinu account if you need one.'
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
				{#if invitation}
					<p class="m-0 text-center text-sm leading-5 break-words text-ink-muted">
						{invitation.email}
					</p>
				{:else}<AuthTextInput
						label="Your work email"
						bind:value={email}
						type="email"
						autocomplete="email"
						required
						autofocus
						invalid={Boolean(authErrorText)}
					/>{/if}
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
						: invitation
							? 'Continue'
							: 'Email me a code'}
				</AuthHotkeyButton>
			</form>
		</AuthStepFrame>
	{:else}
		<AuthCodeStep
			{email}
			description={invitation ? `Verify your email to join ${invitation.companyName}.` : undefined}
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

{#if invitation}<div id="clerk-captcha"></div>{/if}
