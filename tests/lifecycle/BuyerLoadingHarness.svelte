<script lang="ts">
	import AnonymousProvider from '../../src/lib/buyer/AnonymousProvider.svelte';
	import BuyerShell from '../../src/lib/buyer/BuyerShell.svelte';
</script>

<AnonymousProvider
	><BuyerShell token={'0'.repeat(39)}><p data-private-buyer>Private buyer content</p></BuyerShell
	></AnonymousProvider
>
