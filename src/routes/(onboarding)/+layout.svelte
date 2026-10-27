<script lang="ts">
	let { children } = $props();
</script>

<main
	class="flex min-h-dvh flex-col justify-center bg-page px-6 py-8 text-ink sm:py-12"
	data-sveltekit-preload-data="off"
	data-sveltekit-preload-code="off"
>
	{@render children()}
</main>
