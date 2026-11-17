<script lang="ts">
	import { onDestroy, untrack } from 'svelte';
	import { useConvexClient } from 'convex-svelte';
	import WorkspaceShell from '../../../src/lib/auth/WorkspaceShell.svelte';
	import WorkspacePresentationReporter from '../../../src/lib/auth/WorkspacePresentationReporter.svelte';
	import TemplateSetup from '../../../src/lib/components/template/TemplateSetup.svelte';
	import { setViewer, setViewerSession } from '../../../src/lib/auth/viewer-session.svelte';
	import { TemplateSource } from '../../../src/lib/playbook/template-source.svelte';
	import {
		TemplateAuthoringSession,
		setTemplateAuthoringSession
	} from '../../../src/lib/playbook/template-authoring-session.svelte';
	import type { CsmState } from '../../support/csm-state.svelte';
	let { state }: { state: CsmState } = $props();
	setViewer(() => state.viewer);
	untrack(() => setViewerSession(state.session));
	const client = useConvexClient();
	const ids = untrack(() => ({
		membershipId: state.viewer.membership.id,
		companyId: state.viewer.company.id
	}));
	const templateSource = new TemplateSource(client, ids.membershipId);
	const sessions = (['rep', 'buyer'] as const).map((audience) => {
		const session = new TemplateAuthoringSession({
			client,
			membershipId: ids.membershipId,
			companyId: ids.companyId,
			audience,
			templateSource,
			registerEditor: () => () => {}
		});
		setTemplateAuthoringSession(session, audience);
		return session;
	});
	onDestroy(() => {
		for (const session of sessions) session.destroy();
		templateSource.destroy();
	});
</script>

<WorkspaceShell>
	<WorkspacePresentationReporter outcome={state.outcome} revision={state.revision} />
	{#if state.form}<TemplateSetup getNavigationIntent={() => 0} />{/if}
</WorkspaceShell>
