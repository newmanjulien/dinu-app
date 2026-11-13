<script lang="ts">
	import { goto } from '$app/navigation';
	import type { AccountViewer } from '$lib/auth/viewer-session.svelte';
	import Avatar from '$lib/components/ui/Avatar.svelte';
	import Menu from '$lib/components/ui/Menu.svelte';
	import MenuItem from '$lib/components/ui/MenuItem.svelte';

	let {
		profile,
		onSignOut
	}: {
		profile: Pick<AccountViewer['profile'], 'name' | 'email' | 'avatarUrl'>;
		onSignOut: () => Promise<void>;
	} = $props();
	let open = $state(false);
	let trigger = $state<HTMLButtonElement>();
	let signingOut = $state(false);
	let error = $state('');

	async function signOut() {
		if (signingOut) return;
		signingOut = true;
		error = '';
		try {
			await onSignOut();
		} catch {
			error = 'Unable to log out. Please try again.';
			open = true;
		} finally {
			signingOut = false;
		}
	}
</script>

<button
	bind:this={trigger}
	type="button"
	class="group inline-flex w-[25px] shrink-0 cursor-pointer items-center justify-center self-stretch focus-visible:outline-none"
	aria-label="Your account"
	aria-haspopup="menu"
	aria-expanded={open}
	aria-controls="account-menu"
	onclick={() => (open = !open)}
	onkeydown={(event) => {
		if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
			event.preventDefault();
			open = true;
		}
	}}
>
	<Avatar
		name={profile.name || profile.email}
		avatarUrl={profile.avatarUrl}
		decorative
		class="size-[25px] transition-shadow duration-150 group-hover:ring-3 group-hover:ring-canvas group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent"
	/>
</button>
<Menu
	{open}
	{trigger}
	gap={6}
	onClose={() => (open = false)}
	id="account-menu"
	label="Your account"
>
	{#snippet children(close)}
		{#each [{ label: 'Settings', href: '/settings' }, { label: 'Manage team', href: '/team' }] as item}
			<MenuItem
				onclick={() => {
					close();
					void goto(item.href);
				}}>{item.label}</MenuItem
			>
		{/each}
		<MenuItem
			disabled={signingOut}
			onclick={() => {
				close();
				void signOut();
			}}>Log out</MenuItem
		>
		{#if error}<p role="alert" class="max-w-52 px-2 py-1 text-xs text-danger">{error}</p>{/if}
	{/snippet}
</Menu>
