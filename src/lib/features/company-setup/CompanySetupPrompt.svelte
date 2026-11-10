<script lang="ts">
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import { useCompanySetup } from './company-setup.svelte';

	const viewer = useViewer();
	const setup = useCompanySetup();
	const prompt = $derived.by(() => {
		const progress = setup.progress;
		if (setup.complete || !progress) return null;
		const account = viewer();
		switch (progress.nextStep) {
			case 'template':
				return account.permissions.manageTemplate
					? {
							message: 'Your company needs a contract template.',
							label: 'Set up template',
							href: '/template'
						}
					: { message: 'An admin needs to set up your company’s contract template.' };
			case 'instructions':
				return account.permissions.manageTemplate
					? {
							message: 'Your template needs instructions.',
							label: 'Add instructions',
							href: '/template'
						}
					: { message: 'An admin needs to add instructions to your company’s template.' };
			case 'contract':
				return {
					message: 'Try creating a contract.',
					label: 'Create contract',
					href: '/contracts/new'
				};
			case 'buyer-link':
				return {
					message: 'Copy your contract’s buyer link.',
					label: 'Open contract',
					href: `/contracts/${progress.contractId}`
				};
			case 'integrations':
				return {
					message: 'Set up your integrations.',
					label: 'Explore integrations',
					href: '/integrations'
				};
			case 'team':
				return { message: 'Invite your team of reps.', label: 'Invite colleagues', href: '/team' };
			default:
				return null;
		}
	});
</script>

{#if prompt}
	<p class="mb-5 text-[13px] text-ink-muted">
		{prompt.message}
		{#if prompt.href}<a class="underline text-accent" href={prompt.href}>{prompt.label}</a>{/if}
	</p>
{/if}
