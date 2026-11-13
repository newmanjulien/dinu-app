<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '$lib/ui/Button.svelte';
	let { reason = 'access-denied' }: { reason?: 'access-denied' | 'unavailable' } = $props();
</script>

<div class="py-5">
	<h1 class="text-base font-medium">
		{reason === 'unavailable'
			? 'This integration isn’t available.'
			: 'Integrations are available to admins'}
	</h1>
	<p class="mt-2 mb-4 text-sm text-ink-muted">
		{reason === 'unavailable'
			? 'Return to Integrations to see the available integrations.'
			: 'Ask a workspace admin about integrations.'}
	</p>
	<Button
		href={reason === 'unavailable' ? resolve('/integrations') : resolve('/contracts')}
		variant="secondary"
		>{reason === 'unavailable' ? 'Back to integrations' : 'Back to Contracts'}</Button
	>
</div>
