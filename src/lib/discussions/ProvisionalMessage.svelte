<script lang="ts">
	import MessageByline from './MessageByline.svelte';
	import InlineAction from '$lib/components/playbook/InlineAction.svelte';
	import OperationStatus from './OperationStatus.svelte';
	import type { DiscussionSession, ProvisionalPost } from './session.svelte';

	let { post, session }: { post: ProvisionalPost; session: DiscussionSession } = $props();
</script>

<div data-discussion-provisional class="p-3.5">
	<MessageByline
		author={post.author}
		viewerKey={post.author.key}
		perspective={session.perspective()}
	/>
	<p class="mt-2.5 mb-0 whitespace-pre-wrap text-ink-secondary [overflow-wrap:anywhere]">
		{post.text || 'Delete selected wording'}
	</p>
	{#if session.hasOperationStatus(post.source)}
		<div class="mt-2.5">
			<OperationStatus
				{session}
				source={post.source}
				label={post.kind === 'reply'
					? 'reply'
					: post.type === 'proposal'
						? 'proposed change'
						: 'comment'}
			/>
		</div>
	{/if}
	{#if post.failed}
		<div class="mt-2.5 text-xs text-danger" role="alert">
			<p>
				{post.failureMessage ??
					(post.kind === 'reply' ? 'We couldn’t reply.' : 'We couldn’t post this message.')}
			</p>
			<InlineAction
				disabled={!session.canRestorePost(post.source)}
				onclick={() => session.restorePostDraft(post.source)}>Edit draft</InlineAction
			>
		</div>
	{/if}
</div>
