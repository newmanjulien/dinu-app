<script lang="ts">
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
	import type { SaveStatus } from '$lib/contract/sessions.svelte';
	import type { SavedContractCard } from '$lib/contract/card';
	import type { Action } from 'svelte/action';
	let {
		contract,
		status,
		deleting = false,
		onRename,
		onDelete,
		observe,
		onWarm,
		onCool
	}: {
		contract: SavedContractCard;
		status?: SaveStatus;
		deleting?: boolean;
		onRename: () => void;
		onDelete: () => void;
		observe: Action<HTMLElement, SavedContractCard>;
		onWarm: () => void;
		onCool: () => void;
	} = $props();
	let open = $state(false);
	let hovered = false;
	let focused = false;
	let trigger = $state<HTMLButtonElement>();
	const menuId = $props.id();
	const date = $derived(
		new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(
			contract.savedAt
		)
	);
</script>

<article
	use:observe={contract}
	class="relative min-w-0 rounded-xl border border-[#e5e5e5] bg-white shadow-[0_1px_2px_rgb(0_0_0/4%)] transition-colors hover:border-[#d5d5d5]"
>
	<a
		href={`/contracts/${contract._id}`}
		data-sveltekit-preload-data="off"
		onmouseenter={() => {
			hovered = true;
			onWarm();
		}}
		onfocus={() => {
			focused = true;
			onWarm();
		}}
		onmouseleave={() => {
			hovered = false;
			if (!focused) onCool();
		}}
		onblur={() => {
			focused = false;
			if (!hovered) onCool();
		}}
		class="flex min-h-[96px] flex-col justify-between gap-1.5 rounded-xl px-5 py-3 pr-12 outline-none focus-visible:ring-1 focus-visible:ring-[#d5d5d5]"
		aria-label={`Open contract for ${contract.companyName}`}
	>
		<h2 class="line-clamp-2 break-words text-sm leading-5 font-medium" title={contract.companyName}>
			{contract.companyName}
		</h2>
		<div class="flex min-w-0 items-center gap-2 text-xs text-ink-muted">
			<Avatar
				name={contract.creator.name}
				avatarUrl={contract.creator.avatarUrl}
				size={20}
				decorative
			/>
			<p class="min-w-0 truncate" title={`Created by ${contract.creator.name}`}>
				Created by {contract.creator.name}
			</p>
		</div>
		<p class="text-xs text-ink-muted">
			Last edited <time datetime={new Date(contract.savedAt).toISOString()}>{date}</time>
		</p>
		{#if status}<p class="text-xs text-ink-muted" role="status">{status}</p>{/if}
	</a>
	<div class="absolute top-2 right-3">
		<SquareIconButton
			bind:element={trigger}
			size="sm"
			type="button"
			disabled={deleting}
			onclick={() => (open = !open)}
			onkeydown={(event) => {
				if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
					event.preventDefault();
					open = true;
				}
			}}
			aria-label={`Options for ${contract.companyName}`}
			aria-haspopup="menu"
			aria-expanded={open}
			aria-controls={open ? menuId : undefined}
		>
			<DotsThreeVerticalIcon size={19} weight="bold" aria-hidden="true" />
		</SquareIconButton>
	</div>
	<Menu
		{open}
		{trigger}
		id={menuId}
		label={`Contract options for ${contract.companyName}`}
		onClose={() => (open = false)}
	>
		{#snippet children(close)}
			<MenuItem
				onclick={() => {
					close();
					onRename();
				}}>Rename</MenuItem
			>
			<MenuItem
				danger
				onclick={() => {
					close();
					onDelete();
				}}>Delete</MenuItem
			>
		{/snippet}
	</Menu>
</article>
