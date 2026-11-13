<script lang="ts">
	import Avatar from '$lib/components/ui/Avatar.svelte';
	let { message }: { message: string } = $props();
</script>

<div class="flex items-start gap-3 rounded-2xl border-hairline border-line p-4">
	<Avatar
		name="Julien Newman"
		avatarUrl="/delegation-julien.jpg"
		fallbackUrl={null}
		class="size-11"
		decorative
	/>
	<div class="min-w-0">
		<h3 class="text-[13px] font-medium">Julien Newman</h3>
		<p class="mt-2 text-[13px] leading-relaxed text-ink-secondary">{message}</p>
	</div>
</div>
