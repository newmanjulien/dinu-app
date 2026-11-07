<script lang="ts">
	import ArrowUpRightIcon from 'phosphor-svelte/lib/ArrowUpRightIcon';
	import BuildingsIcon from 'phosphor-svelte/lib/BuildingsIcon';
	import UsersIcon from 'phosphor-svelte/lib/UsersIcon';
	import OnboardingStepFrame from './OnboardingStepFrame.svelte';

	let {
		oncreate,
		onjoin,
		disabled
	}: { oncreate: () => void; onjoin: () => void; disabled: boolean } = $props();
</script>

<OnboardingStepFrame
	title="Get started with your team"
	description="Create a company for your team, or join one through a colleague’s invitation."
>
	<div class="grid gap-3 sm:grid-cols-2">
		<button
			type="button"
			class="group w-full cursor-pointer rounded-xl p-1.5 text-left outline-none transition-colors enabled:hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-60 motion-reduce:transition-none"
			{disabled}
			onclick={oncreate}
		>
			<div
				class="relative aspect-[1047/605] overflow-hidden rounded-xl border-hairline border-edge bg-surface p-[5.5%] shadow-card"
			>
				<div class="flex items-center gap-1 text-[13px] font-medium text-ink">
					Create a company
					<ArrowUpRightIcon
						aria-hidden="true"
						class="size-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
					/>
				</div>
				<p class="mt-1 text-xs leading-5 text-ink-muted">Set up a private space for your team.</p>
				<div
					aria-hidden="true"
					class="absolute top-[47%] left-[10%] w-[110%] -rotate-[4.5deg] rounded-xl border-hairline border-line bg-surface p-4.5 shadow-control transition-transform duration-120 ease-[ease] group-hover:-rotate-[2.5deg] group-focus-visible:-rotate-[2.5deg] motion-reduce:transition-none"
				>
					<div
						class="inline-flex size-10 items-center justify-center rounded-button-lg border-hairline border-line bg-canvas text-ink-muted/50"
					>
						<BuildingsIcon class="size-5.5" weight="light" />
					</div>
					<div class="mt-5 h-1.5 w-28 rounded-full bg-canvas"></div>
					<div class="mt-2.5 h-1.5 w-44 rounded-full bg-canvas"></div>
					<div class="mt-2.5 h-1.5 w-36 rounded-full bg-canvas"></div>
				</div>
			</div>
		</button>
		<button
			type="button"
			class="group w-full cursor-pointer rounded-xl p-1.5 text-left outline-none transition-colors enabled:hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-60 motion-reduce:transition-none"
			{disabled}
			onclick={onjoin}
		>
			<div
				class="relative aspect-[1047/605] overflow-hidden rounded-xl border-hairline border-edge bg-surface p-[5.5%] shadow-card"
			>
				<div class="flex items-center gap-1 text-[13px] font-medium text-ink">
					Join your team
					<ArrowUpRightIcon
						aria-hidden="true"
						class="size-3 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
					/>
				</div>
				<p class="mt-1 text-xs leading-5 text-ink-muted">Already using Dinu? Join by invitation.</p>
				<div
					aria-hidden="true"
					class="absolute top-[47%] left-[10%] w-[110%] -rotate-[4.5deg] rounded-xl border-hairline border-line bg-surface p-4.5 shadow-control transition-transform duration-120 ease-[ease] group-hover:-rotate-[2.5deg] group-focus-visible:-rotate-[2.5deg] motion-reduce:transition-none"
				>
					<div
						class="inline-flex size-10 items-center justify-center rounded-button-lg border-hairline border-line bg-canvas text-ink-muted/50"
					>
						<UsersIcon class="size-5.5" weight="light" />
					</div>
					<div class="mt-5 flex gap-2">
						{#each [1, 2, 3] as person (person)}
							<div
								class="flex size-8 items-center justify-center rounded-full bg-canvas text-ink-muted/30"
							>
								<UsersIcon class="size-3.5" weight="light" />
							</div>
						{/each}
					</div>
					<div class="mt-3 h-1.5 w-36 rounded-full bg-canvas"></div>
				</div>
			</div>
		</button>
	</div>
</OnboardingStepFrame>
