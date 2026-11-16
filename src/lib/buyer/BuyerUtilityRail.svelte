<script lang="ts">
	import { getBuyerContract } from './contract.svelte';
	import UtilityRail from '$lib/components/chrome/UtilityRail.svelte';
	import { helpContent } from '$lib/components/ui/modal/help-content';
	const contract = getBuyerContract();
	const download = contract.download;
	let desktop = $state<HTMLElement>();
	let mobile = $state<HTMLElement>();
	const tools = $derived(contract.allowed && !contract.error ? contract.tools : undefined);
	const owner = $derived(tools?.owner);
	$effect(() => tools?.setRails(desktop, mobile));
</script>

<UtilityRail
	states={{
		...(tools?.states ?? {
			search: { applicability: 'present', display: 'ready', enabled: false },
			settings: { applicability: 'absent', display: 'ready' },
			help: {
				applicability: 'present',
				display: 'ready',
				enabled: contract.help.resolved
			}
		}),
		download: { applicability: 'present', display: 'ready', enabled: !download.reason }
	}}
	interactionOwner={owner}
	bind:desktopElement={desktop}
	bind:mobileElement={mobile}
	searchOpen={tools?.searchOpen ?? false}
	searchEnabled={tools?.searchEnabled ?? false}
	onSearchToggle={(button) => {
		tools?.onSearchToggle(button);
	}}
	helpLabel={helpContent.buyer.title}
	helpEnabled={tools?.helpEnabled ?? contract.help.resolved}
	onOpenHelp={() => {
		if (tools) tools.onOpenHelp();
		else if (contract.help.resolved) contract.help.openManually();
	}}
	onDownload={() => {
		void download.start();
	}}
	downloadReason={download.reason}
/>
