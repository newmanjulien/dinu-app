<script lang="ts">
	import { useViewer } from '$lib/auth/viewer-session.svelte';

	const viewer = useViewer();
	const prompt = $derived.by(() => {
		const account = viewer();
		if (!account.templateReady)
			return account.permissions.manageTemplate
				? {
						message: 'Your company needs a baseline contract.',
						label: 'Set up contract',
						href: '/admin'
					}
				: { message: 'An admin needs to set up your company’s baseline contract.' };
		if (!account.instructionsReady)
			return account.permissions.manageTemplate
				? {
						message: 'Your contract needs instructions.',
						label: 'Add instructions',
						href: '/admin'
					}
				: { message: 'An admin needs to add instructions to your contract.' };
		if (!account.colleaguesInvited && account.permissions.manageMembers)
			return { message: 'Invite your team of reps.', label: 'Invite colleagues', href: '/team' };
		return null;
	});
</script>

{#if prompt}
	<p class="mb-5 text-[13px] text-ink-muted">
		{prompt.message}
		{#if prompt.href}<a class="underline text-accent" href={prompt.href}>{prompt.label}</a>{/if}
	</p>
{/if}
