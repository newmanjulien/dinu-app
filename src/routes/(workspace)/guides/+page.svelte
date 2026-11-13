<script lang="ts">
	import { useViewer } from '$lib/auth/viewer-session.svelte';
	import WorkspacePresentationReporter from '$lib/auth/WorkspacePresentationReporter.svelte';
	import GuidesLayout from '$lib/components/workspace/GuidesLayout.svelte';

	const viewer = useViewer();
</script>

<WorkspacePresentationReporter outcome="success" />
<GuidesLayout role={viewer().membership.role} />
