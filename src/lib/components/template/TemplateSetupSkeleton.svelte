<script lang="ts">
	import type { Role } from '../../../convex/permissions';
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	let { role }: { role?: Role } = $props();
</script>

<div
	aria-hidden="true"
	class="min-h-[calc(100dvh-var(--app-header-height))] bg-page px-4 pt-10 pb-12 sm:px-6 sm:pt-16 sm:pb-16 md:px-8"
>
	<div class="mx-auto max-w-[1262px]">
		<div class="mx-auto mb-9 max-w-[440px] text-center">
			<h1 class="text-[20px] leading-8 font-medium tracking-[-0.025em] text-ink">
				Set up your company’s template
			</h1>
			{#if role}
				<p class="mt-1 text-[13px] leading-6 text-ink-muted">
					{#if role === 'admin'}
						Upload the Word document your team will use as the template for new contracts.
					{:else}
						Your team can start creating contracts once an admin sets up your company’s template.
					{/if}
				</p>
			{/if}
		</div>
		<div class="mx-auto max-w-[780px]">
			{#if role === 'admin'}
				<div
					class="flex min-h-[283px] flex-col items-center justify-center rounded-2xl bg-surface px-5 py-8 text-center sm:px-10"
				>
					<SkeletonBlock class="mb-3 size-9" />
					<SkeletonBlock class="w-fit text-[15.5px] leading-6 font-medium"
						>Drop your Word document here</SkeletonBlock
					>
					<SkeletonBlock class="mx-auto mt-1.5 w-fit max-w-[440px] text-[13px] leading-5"
						>Or choose a Word file from your computer.</SkeletonBlock
					>
					<SkeletonBlock
						class="mt-5 h-button-sm whitespace-nowrap rounded-button-lg px-[13px] py-[7.5px] text-[12.5px] font-normal"
						>Choose a Word file</SkeletonBlock
					>
				</div>
			{:else if role}
				<div
					class="flex min-h-[250px] flex-col items-center justify-center rounded-base border-hairline border-edge bg-surface px-6 py-10 text-center shadow-card"
				>
					<SkeletonBlock class="mb-4 size-11 rounded-button-xl" />
					<SkeletonBlock class="w-fit text-[14px] leading-6 font-medium"
						>Waiting for your company’s template</SkeletonBlock
					>
					<SkeletonBlock class="mt-1 w-fit max-w-[360px] text-[13px] leading-6"
						>Contact an admin on your company team to finish setup.</SkeletonBlock
					>
				</div>
			{/if}
			{#if role}
				<div
					class="mt-4 flex items-start gap-2.5 rounded-xl bg-canvas/80 px-4 py-3 text-[13px] leading-relaxed"
				>
					<SkeletonBlock class="mt-0.5 size-4 shrink-0" />
					<SkeletonBlock class="min-w-0">
						<span class="font-semibold"
							>{role === 'admin'
								? 'This feature is in beta.'
								: 'Your admin needs to finish setup.'}</span
						>
						<span class="ml-1"
							>{role === 'admin'
								? "Please email help@juliennewman.com if you can't upload your template."
								: 'Ask an admin to set up your company’s template.'}</span
						>
					</SkeletonBlock>
				</div>
			{/if}
		</div>
	</div>
</div>
