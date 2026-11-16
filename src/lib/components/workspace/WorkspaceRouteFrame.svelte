<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { DocumentWorkspace } from '$lib/document/runtime/workspace-context';
	import type { HelpSession } from '$lib/components/ui/modal/help-session.svelte';
	import type { HelpVariant } from '$lib/components/ui/modal/help-content';
	import type { TemplateAudience } from '$lib/playbook/model';
	import DocumentHeading from '$lib/components/document/DocumentHeading.svelte';
	import WorkspaceChrome from './WorkspaceChrome.svelte';

	let {
		kind,
		audience = 'rep',
		helpVariant,
		helpReady = false,
		help,
		helpHosted = false,
		active = true,
		workspace,
		interactionOwner,
		settingsHref,
		onDownload,
		downloadReason,
		error,
		onRetry,
		children
	}: {
		kind: 'saved' | 'template';
		audience?: TemplateAudience;
		helpVariant?: Exclude<HelpVariant, 'buyer'>;
		helpReady?: boolean;
		help?: HelpSession;
		helpHosted?: boolean;
		active?: boolean;
		workspace?: DocumentWorkspace;
		interactionOwner?: symbol;
		settingsHref?: string;
		onDownload?: () => void;
		downloadReason?: string | null;
		error?: string;
		onRetry?: () => void;
		children: Snippet;
	} = $props();
</script>

{#if active && helpVariant}
	<WorkspaceChrome
		{helpVariant}
		{helpReady}
		{help}
		{helpHosted}
		{workspace}
		{interactionOwner}
		{settingsHref}
		{onDownload}
		{downloadReason}
	/>
{/if}
<DocumentHeading {kind} {audience} />
{#if error}<div role="alert" class="mx-auto max-w-3xl px-6 py-3 text-center text-sm text-danger">
		<p>{error}</p>
		{#if onRetry}<button type="button" class="mt-2 underline" onclick={onRetry}>Try again</button
			>{/if}
	</div>{/if}
{@render children()}
