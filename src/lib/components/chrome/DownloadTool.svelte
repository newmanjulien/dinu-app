<script lang="ts">
	import DownloadSimpleIcon from 'phosphor-svelte/lib/DownloadSimpleIcon';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import Tooltip from '$lib/components/ui/Tooltip.svelte';
	let { reason = null, onDownload }: { reason?: string | null; onDownload: () => void } = $props();
	let trigger = $state<HTMLButtonElement | null>();
</script>

<Tooltip
	text={reason ?? 'Download as .docx'}
	trigger={trigger ?? undefined}
	standalone={false}
	class="rounded-md border-hairline border-edge bg-surface px-2 py-1 text-xs leading-[1.4] text-ink shadow-floating"
>
	{#snippet children(descriptionId)}
		<SquareIconButton
			bind:element={trigger}
			type="button"
			class="rounded-button-lg min-[1000px]:size-8 aria-disabled:cursor-default aria-disabled:text-ink-muted aria-disabled:hover:bg-transparent"
			aria-label="Download document as .docx"
			aria-disabled={Boolean(reason)}
			aria-describedby={descriptionId}
			onclick={() => {
				if (!reason) onDownload();
			}}
			><DownloadSimpleIcon
				class="size-5 min-[1000px]:size-[18px]"
				aria-hidden="true"
			/></SquareIconButton
		>
	{/snippet}
</Tooltip>
