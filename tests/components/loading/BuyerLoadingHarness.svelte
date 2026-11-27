<script lang="ts">
	import AnonymousProvider from '../../../src/lib/buyer/AnonymousProvider.svelte';
	import BuyerShell from '../../../src/lib/buyer/BuyerShell.svelte';
	import type { Id } from '../../../src/convex/_generated/dataModel';
	const templateVersionId = 'version' as Id<'templateVersions'>;
</script>

<AnonymousProvider
	><BuyerShell token="Ab3Cd4Ef5Gh6I" {templateVersionId}
		><p data-private-buyer>Private buyer content</p></BuyerShell
	></AnonymousProvider
>
