<script lang="ts">
	import { onDestroy } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import { getContractEditors } from '$lib/contract/editors.svelte';
	import { BuyerLinkController } from '$lib/buyer/links.svelte';
	import { getBuyerLinkCopyFeedback } from '$lib/buyer/copy-feedback.svelte';
	import { useCompanySetup } from './company-setup.svelte';

	const viewer = useViewer();
	const setup = useCompanySetup();
	const client = useConvexClient();
	const editors = getContractEditors();
	const feedback = getBuyerLinkCopyFeedback();
	let links = $state.raw<BuyerLinkController>();
	onDestroy(() => links?.destroy());

	async function createLink() {
		const progress = setup.progress;
		if (links?.busy || progress?.nextStep !== 'buyer-link' || !progress.contractId) return;
		links?.destroy();
		const controller = new BuyerLinkController(
			client,
			editors,
			viewer().membership.id,
			progress.contractId,
			feedback.show
		);
		links = controller;
		await controller.copy();
		if (controller.error) feedback.showError(controller.error);
	}

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
							href: '/template/setup'
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
					message: 'Create a buyer link for your latest contract.',
					label: 'Create link'
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
	<p class="mb-5 text-[13.5px] text-ink-muted">
		{prompt.message}
		{#if prompt.href}
			<a class="underline text-accent" href={prompt.href}>{prompt.label}</a>
		{:else if setup.progress?.nextStep === 'buyer-link'}
			<button
				type="button"
				class="cursor-pointer underline text-accent disabled:cursor-default disabled:text-ink-muted"
				disabled={Boolean(links?.busy)}
				aria-busy={Boolean(links?.busy)}
				onclick={() => void createLink()}>{links?.busy ?? prompt.label}</button
			>
		{/if}
	</p>
{/if}
