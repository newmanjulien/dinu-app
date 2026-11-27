<script lang="ts">
	import BuyerShell from '../../../src/lib/buyer/BuyerShell.svelte';
	import { setPageMetadata } from '../../../src/lib/auth/page-metadata.svelte';
	import type { Id } from '../../../src/convex/_generated/dataModel';
	const templateVersionId = 'version' as Id<'templateVersions'>;
	setPageMetadata();
</script>

<BuyerShell token="Ab3Cd4Ef5Gh6I" {templateVersionId} hasAccountSession>
	<p data-document-body>Contract body</p>
</BuyerShell>
