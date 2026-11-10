<script lang="ts">
	import SkeletonBlock from '$lib/ui/SkeletonBlock.svelte';
	import AuthProgressDots from '../components/AuthProgressDots.svelte';
	import OnboardingStepFrame from './OnboardingStepFrame.svelte';
	let { announce = true }: { announce?: boolean } = $props();
</script>

{#if announce}<span role="status" class="sr-only">Connecting your account</span>{/if}

<AuthProgressDots step={3} />
<div class="m-auto w-full max-w-190 pt-7 pb-15 text-center">
	<OnboardingStepFrame
		title="Get started with your team"
		description="Create a company for your team, or join one through a colleague’s invitation."
	>
		<div aria-hidden="true" class="grid gap-3 sm:grid-cols-2">
			{#each [0, 1] as card (card)}
				<div class="p-1.5">
					<div
						class="relative aspect-[1047/605] overflow-hidden rounded-xl border-hairline border-edge bg-surface p-[5.5%] shadow-card"
					>
						<SkeletonBlock class="h-4 w-28" />
						<SkeletonBlock class="mt-1 h-5 w-4/5" />
						<div
							class="absolute top-[47%] left-[10%] w-[110%] -rotate-[4.5deg] rounded-xl border-hairline border-line bg-surface p-4.5 shadow-control"
						>
							<SkeletonBlock class="size-10 rounded-button-lg" />
							{#if card === 0}
								<SkeletonBlock class="mt-5 h-1.5 w-28 rounded-full" />
								<SkeletonBlock class="mt-2.5 h-1.5 w-44 rounded-full" />
								<SkeletonBlock class="mt-2.5 h-1.5 w-36 rounded-full" />
							{:else}
								<div class="mt-5 flex gap-2">
									{#each [0, 1, 2] as person (person)}<SkeletonBlock
											class="size-8 rounded-full"
										/>{/each}
								</div>
								<SkeletonBlock class="mt-3 h-1.5 w-36 rounded-full" />
							{/if}
						</div>
					</div>
				</div>
			{/each}
		</div>
	</OnboardingStepFrame>
</div>
<div aria-hidden="true" class="translate-y-2 pt-1 pb-1">
	<SkeletonBlock class="mx-auto h-4 w-12" />
</div>
