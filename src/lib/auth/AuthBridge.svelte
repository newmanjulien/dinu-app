<script lang="ts">
	import { useClerkContext } from 'svelte-clerk';
	import SessionStatus from './SessionStatus.svelte';
	import { AccountLifecycle } from './account-lifecycle.svelte';
	import { setViewerSession, type SessionResources } from './viewer-session.svelte';
	import { loginDestination } from './navigation';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount, untrack, type Snippet } from 'svelte';
	let { children }: { children: Snippet } = $props();
	const clerk = useClerkContext();
	let alive = true;
	const resources = new Set<SessionResources>();
	const controller = new AccountLifecycle({
		signOut: async () => {
			if (!clerk.clerk) throw new Error('Authentication is unavailable.');
			await clerk.clerk.signOut(() => {});
		},
		cancelReads: () => resources.forEach((resource) => resource.cancelReads()),
		clear: () => resources.forEach((resource) => resource.clear()),
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
		reset: () => controller.reset(),
		signOut: () => controller.signOut(),
		exitCompany: (action, discard) => controller.exitCompany(action, discard),
		completeAccountDeletion: ({ sessionId, userId }) => {
			void import('$lib/contract/draft-recovery.svelte').then(({ discardUserDrafts }) =>
				discardUserDrafts(userId)
			);
			if (
				!alive ||
				(clerk.session && clerk.session.id !== sessionId) ||
				(clerk.user && clerk.user.id !== userId)
			)
				return;
			controller.reset(false);
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
			if (initial && !sessionId && !['/login', '/join', '/invitation'].includes(page.url.pathname))
				controller.reset(true);
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
