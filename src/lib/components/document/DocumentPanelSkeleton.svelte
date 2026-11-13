<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import DocumentPanelRail from './DocumentPanelRail.svelte';
	import PlaybookCard from '$lib/components/playbook/PlaybookCard.svelte';
</script>

<DocumentPanelRail pending interactive={false}>
	<PlaybookCard label="Loading document panel">
		<SkeletonBlock class="h-[19px] w-2/3" />
		<SkeletonBlock class="w-full" />
		<SkeletonBlock class="w-3/4" />
		<SkeletonBlock quiet class="h-24 w-full rounded" />
	</PlaybookCard>
</DocumentPanelRail>
