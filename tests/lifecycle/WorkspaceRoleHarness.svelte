<script lang="ts">
	import WorkspaceSkeleton from '../../src/lib/auth/WorkspaceSkeleton.svelte';
	import { setWorkspaceRole, type WorkspaceRole } from '../../src/lib/auth/workspace-role.svelte';
	let { owner }: { owner: WorkspaceRole } = $props();
	setWorkspaceRole(() => owner.roleFor('user', 'session'));
</script>

<WorkspaceSkeleton />
