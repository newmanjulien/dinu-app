<script lang="ts">
	import { DEFAULT_USER_AVATAR_URL, resolveAvatarUrl } from '$lib/avatar';
	import UserIcon from 'phosphor-svelte/lib/UserIcon';

	let {
		name,
		avatarUrl,
		fallbackUrl = DEFAULT_USER_AVATAR_URL,
		size = 24,
		decorative = false
	}: {
		name: string;
		avatarUrl: string | null;
		fallbackUrl?: string | null;
		size?: number;
		decorative?: boolean;
	} = $props();
	let failedUrl = $state<string | null>(null);
	let failedFallbackUrl = $state<string | null>(null);
	const uploadedSrc = $derived(resolveAvatarUrl(avatarUrl));
	const fallbackSrc = $derived(resolveAvatarUrl(fallbackUrl));
	const src = $derived(
		(uploadedSrc !== failedUrl && uploadedSrc) ||
			(fallbackSrc !== failedFallbackUrl && fallbackSrc) ||
			null
	);
	const initials = $derived.by(() => {
		const words = name.trim().split(/\s+/).filter(Boolean);
		return [words[0], ...(words.length > 1 ? [words[words.length - 1]] : [])]
			.map((word) => Array.from(word ?? '')[0] ?? '')
			.join('')
			.toUpperCase();
	});
</script>

<span
	role="img"
	aria-label={name}
	aria-hidden={decorative}
	class="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-fill-subtle text-[10px] font-medium text-ink-muted"
	style:width={`${size}px`}
	style:height={`${size}px`}
>
	{#if src}
		<img
			{src}
			alt=""
			width={size}
			height={size}
			class="size-full object-cover"
			onerror={(event) => {
				const failedSrc = event.currentTarget.getAttribute('src');
				if (failedSrc === uploadedSrc) failedUrl = failedSrc;
				if (failedSrc === fallbackSrc) failedFallbackUrl = failedSrc;
			}}
		/>
	{:else if initials}
		{initials}
	{:else}
		<UserIcon size={size * 0.6} aria-hidden="true" />
	{/if}
</span>
