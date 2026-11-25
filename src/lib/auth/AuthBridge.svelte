<script lang="ts">
	import { useClerkContext } from 'svelte-clerk';
	import SessionStatus from './SessionStatus.svelte';
	import { AccountLifecycle } from './account-lifecycle.svelte';
	import { setViewerSession, type SessionResources } from './viewer-session.svelte';
	import { isEntryPath, loginDestination } from './navigation';
	import { ReadAttempt, waitForRead } from './attempt';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount, tick, untrack, type Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const clerk = useClerkContext();
	let alive = true;
	const resources = new Set<SessionResources>();
	async function signOutClerk(allowClientDestroy: boolean) {
		const instance = clerk.clerk;
		if (!instance) {
			if (!clerk.session) return;
			throw new Error('Authentication is unavailable.');
		}
		const attempt = allowClientDestroy ? new ReadAttempt(15_000) : undefined;
		const bounded = <T,>(work: Promise<T>) => (attempt ? waitForRead(work, attempt.signal) : work);
		async function destroyClient() {
			if (!allowClientDestroy || !instance?.client || attempt?.signal.aborted) return false;
			try {
				await bounded(instance.client.destroy());
			} catch {
				/* Fall through to active-session verification below. */
			}
			await tick();
			return !clerk.session && !instance.session;
		}
		try {
			try {
				await bounded(instance.signOut(() => {}));
			} catch (error) {
				await tick();
				if (!clerk.session && !instance.session) return;
				if (await destroyClient()) return;
				throw error;
			}
			await tick();
			if (clerk.session || instance.session) {
				if (await destroyClient()) return;
				throw new Error('Unable to clear your session.');
			}
		} finally {
			attempt?.complete();
		}
	}
	const controller = new AccountLifecycle({
		signOut: () => signOutClerk(false),
		signOutDeleted: () => signOutClerk(true),
		cancelReads: () => resources.forEach((resource) => resource.cancelReads()),
		clear: () =>
			resources.forEach((resource) => {
				resource.endSession?.();
				resource.clear();
			}),
		login: async (recover) => {
			await goto(loginDestination(page.url, recover), { invalidateAll: true });
		}
	});
	setViewerSession({
		get closing() {
			return controller.closing;
		},
		get preparedSessionId() {
			return controller.preparedSessionId;
		},
		get userId() {
			return controller.userId;
		},
		get phase() {
			return controller.phase;
		},
		get error() {
			return controller.error;
		},
		get authenticationError() {
			return controller.authenticationError;
		},
		get delayed() {
			return controller.delayed;
		},
		get blocked() {
			return controller.blocked;
		},
		get workspaceAdmitted() {
			return controller.workspaceAdmitted;
		},
		get transportGeneration() {
			return controller.transportGeneration;
		},
		registerEditor: (editor) => controller.registerEditor(editor),
		registerResources: (resource) => {
			resources.add(resource);
		},
		reportAuth: (loading, authenticated) => controller.reportAuth(loading, authenticated),
		reportAccount: (ready, error) => controller.reportAccount(ready, error),
		retryAuth: () => controller.retryAuth(),
		cancelSignOut: () => controller.cancelSignOut(),
		discardAndSignOut: () => controller.discardAndSignOut(),
		dismissError: () => controller.dismissError(),
		returnToLogin: () => controller.returnToLogin(),
		signOut: () => controller.signOut(),
		exitCompany: (action, discard) => {
			const userId = controller.userId;
			return controller.exitCompany(async () => {
				await action();
				if (userId) resources.forEach((resource) => resource.forgetMembership?.(userId));
			}, discard);
		},
		completeAccountDeletion: ({ sessionId, userId }) => {
			resources.forEach((resource) => resource.forgetMembership?.(userId));
			void import('$lib/contract/draft-recovery.svelte').then(({ discardUserDrafts }) =>
				discardUserDrafts(userId)
			);
			if (
				!alive ||
				(clerk.session && clerk.session.id !== sessionId) ||
				(clerk.user && clerk.user.id !== userId)
			)
				return Promise.resolve();
			return controller.completeAccountDeletion();
		}
	});
	let identity: string | null | undefined;
	$effect(() => {
		const loaded = clerk.isLoaded;
		const sessionId = clerk.auth.sessionId ?? clerk.session?.id ?? null;
		const userId = clerk.auth.userId ?? clerk.user?.id ?? null;
		untrack(() => {
			if (!loaded) return;
			const initial = identity === undefined;
			identity = sessionId;
			controller.identity(sessionId, userId, loaded);
			if (initial && !sessionId && !isEntryPath(page.url.pathname)) controller.returnToLogin(true);
		});
	});
	onMount(() => controller.start());
	onDestroy(() => {
		alive = false;
		controller.destroy();
		resources.forEach((resource) => resource.clear());
	});
</script>

{@render children()}
<SessionStatus {controller} />
