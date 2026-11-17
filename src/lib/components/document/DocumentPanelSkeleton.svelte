<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import DocumentPanelRail from './DocumentPanelRail.svelte';
	import DocumentPanelCard from './DocumentPanelCard.svelte';
	import DocumentPanelBody from './DocumentPanelBody.svelte';
</script>

<DocumentPanelRail pending interactive={false}>
	<DocumentPanelCard label="Loading document panel">
		<DocumentPanelBody>
			<SkeletonBlock class="h-[19px] w-2/3" />
			<SkeletonBlock class="w-full" />
			<SkeletonBlock class="w-3/4" />
			<SkeletonBlock quiet class="h-24 w-full rounded" />
		</DocumentPanelBody>
	</DocumentPanelCard>
</DocumentPanelRail>
