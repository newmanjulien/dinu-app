<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '$lib/ui/Button.svelte';
</script>

<div class="py-5">
	<h1 class="text-base font-medium">This integration isn’t available.</h1>
	<p class="mt-2 mb-4 text-sm text-ink-muted">
		Return to Integrations to see the available integrations.
	</p>
	<Button href={resolve('/integrations')} variant="secondary">Back to integrations</Button>
</div>
