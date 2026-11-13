<script lang="ts">
	import TeamListLayout from './TeamListLayout.svelte';
	import TeamRowLayout from './TeamRowLayout.svelte';
	let { invitations = false, canManage = false }: { invitations?: boolean; canManage?: boolean } =
		$props();
</script>

<TeamListLayout loading>
	{#each Array.from({ length: invitations ? 3 : 4 }) as _, index (index)}<TeamRowLayout
			{invitations}
			{canManage}
		/>{/each}
</TeamListLayout>
