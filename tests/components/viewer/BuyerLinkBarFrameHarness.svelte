<script lang="ts">
	import SavedDocumentFrame from '../../../src/lib/components/workspace/SavedDocumentFrame.svelte';
	import type { ContractEditor } from '../../../src/lib/contract/editors.svelte';
	import type { ContractBuyerLink } from '../../../src/lib/contract/saved';
	import { setDocumentSection } from '../../../src/lib/document/runtime/section.svelte';

	let {
		editor,
		interactionAdmitted
	}: {
		editor: {
			id: string;
			readable: unknown;
			documentInput: unknown;
			renderChoices: Record<string, string>;
			definitionsReady: boolean;
			persistence: { deleted: boolean; workBlock: string | null } | undefined;
			buyerLink: ContractBuyerLink | null | undefined;
			hasUnreadComment: boolean;
		};
		interactionAdmitted: boolean;
	} = $props();
	setDocumentSection({
		identity: Symbol('test-section'),
		viewport: undefined,
		active: true
	});
</script>

<SavedDocumentFrame
	editor={editor as unknown as ContractEditor}
	{interactionAdmitted}
	onRetry={() => {}}
/>
