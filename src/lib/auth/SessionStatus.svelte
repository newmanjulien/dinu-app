<script lang="ts">
	import type { SessionController } from './session-controller.svelte';
	import ModalShell from '$lib/ui/ModalShell.svelte';
	let { controller }: { controller: SessionController } = $props();
	const saving = $derived(controller.phase === 'saving-before-logout');
	const signingOut = $derived(controller.phase === 'signing-out');
	const authFailure = $derived(controller.phase === 'authentication-error');
	const waiting = $derived(['loading', 'authenticating', 'preparing'].includes(controller.phase));
	const show = $derived(
		saving ||
			signingOut ||
			(controller.admitted && (authFailure || (waiting && controller.delayed))) ||
			(Boolean(controller.error) && (controller.admitted || controller.phase === 'signed-out'))
	);
	const title = $derived(
		saving
			? 'Saving before logout'
			: signingOut
				? 'Logging out'
				: authFailure
					? 'Unable to connect your account'
					: controller.error
						? 'Please try again'
						: 'Still connecting'
	);
	function closeStatus() {
		if (saving) controller.cancelSignOut();
		else if (controller.phase === 'ready') controller.dismissError();
	}
</script>

<ModalShell
	open={show}
	{title}
	maxWidth={448}
	dismissible={saving || controller.phase === 'ready'}
	showCloseButton={false}
	closeOnBackdrop={false}
	onClose={closeStatus}
>
	<p class="text-sm text-ink-muted" role={controller.error || authFailure ? 'alert' : 'status'}>
		{controller.error ||
			(authFailure
				? controller.authenticationError
				: saving
					? 'Waiting for pending saves before your session ends.'
					: signingOut
						? controller.delayed
							? 'Logout is taking longer than usual. Waiting for your account provider.'
							: 'Waiting for your account provider…'
						: 'This is taking longer than usual. You can retry the connection or log out.')}
	</p>
	<div class="mt-5 flex flex-wrap gap-4 text-sm">
		{#if saving}
			{#if controller.error}<button class="underline" onclick={() => void controller.signOut()}
					>Retry saving</button
				>{/if}
			<button class="underline" onclick={() => controller.cancelSignOut()}>Cancel logout</button>
			{#if controller.error || controller.delayed}<button
					class="underline"
					onclick={() => controller.discardAndSignOut()}>Discard changes and log out</button
				>{/if}
		{:else if controller.phase === 'signed-out'}
			<button class="underline" onclick={() => controller.returnToLogin()}>Return to login</button>
		{:else if !signingOut}
			{#if authFailure || waiting}<button class="underline" onclick={() => controller.retryAuth()}
					>Try again</button
				>{/if}
			<button class="underline" onclick={() => void controller.signOut()}>Log out</button>
			{#if controller.error && !authFailure && !waiting}<button
					class="underline"
					onclick={() => controller.dismissError()}>Close</button
				>{/if}
		{/if}
	</div>
</ModalShell>
