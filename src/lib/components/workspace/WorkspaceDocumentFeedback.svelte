<script lang="ts">
	import { onDestroy } from 'svelte';
	import { getWorkspaceFeedback } from '$lib/components/chrome/workspace-feedback.svelte';
	import type { OperationStatus } from '$lib/components/chrome/operation-status';
	import type { DocumentWorkspace } from '$lib/document/runtime/workspace-context';

	let {
		workspace,
		feedback = null
	}: { workspace?: DocumentWorkspace; feedback?: OperationStatus | null } = $props();
	onDestroy(
		getWorkspaceFeedback().registerDocument({
			get feedback() {
				return feedback;
			},
			get renderError() {
				return workspace?.viewer.displayedSnapshot ? workspace.renderer.error : null;
			},
			get sourceStale() {
				return Boolean(workspace?.viewer.displayedSnapshot && workspace.source.issue);
			},
			get onRetryRender() {
				return workspace?.viewer.retry;
			}
		})
	);
</script>
