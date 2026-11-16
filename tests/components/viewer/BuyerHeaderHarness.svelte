<script lang="ts">
	import BuyerShell from '../../../src/lib/buyer/BuyerShell.svelte';
	import { setPageMetadata } from '../../../src/lib/auth/page-metadata.svelte';
	setPageMetadata();
</script>

<BuyerShell token="Ab3Cd4Ef5Gh6I" hasAccountSession>
	<p data-document-body>Contract body</p>
</BuyerShell>
