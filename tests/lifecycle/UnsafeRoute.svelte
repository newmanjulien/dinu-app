<script lang="ts">
	import { page } from './navigation.svelte';
	const metadata = {
		get id() {
			return (page.data.contractRoute as { id: string }).id;
		}
	};
	$effect(() => {
		document.body.dataset.unsafeId = metadata.id;
	});
</script>
