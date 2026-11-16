<script lang="ts">
	import type { FunctionReturnType } from 'convex/server';
	import type { api } from '../../../convex/_generated/api';
	import type { Role } from '../../../convex/permissions';
	import LinkActivity from '$lib/buyer/LinkActivity.svelte';
	import BuyerLinksLayout from './BuyerLinksLayout.svelte';

	let {
		role,
		showContent = true,
		unreadCurrent = true,
		emptyMessage,
		links,
		hasMore,
		loading,
		error,
		onShowMore,
		onRetry
	}: {
		role: Role;
		showContent?: boolean;
		unreadCurrent?: boolean;
		emptyMessage?: string;
		links: FunctionReturnType<typeof api.buyerLinks.browse>['page'];
		hasMore: boolean;
		loading: boolean;
		error: boolean;
		onShowMore: () => void;
		onRetry: () => void;
	} = $props();
</script>

<BuyerLinksLayout
	{role}
	{showContent}
	{unreadCurrent}
	{links}
	{hasMore}
	{loading}
	{error}
	{onShowMore}
	{onRetry}
	{emptyMessage}
>
	{#snippet activity(id)}<LinkActivity {id} />{/snippet}
</BuyerLinksLayout>
