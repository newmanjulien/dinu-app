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

	const choiceClass =
		'group w-full cursor-pointer rounded-xl p-1.5 text-left outline-none transition-colors enabled:hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default disabled:opacity-60 motion-reduce:transition-none';
</script>

<OnboardingStepFrame
	title="Get started with your team"
	description="Create a company for your team, or join one through a colleague’s invitation."
>
	<div class="grid gap-3 sm:grid-cols-2">
		<button type="button" class={choiceClass} {disabled} onclick={oncreate}>
			<div class="choice-card rounded-xl">
				<div class="flex items-center gap-1 text-[13px] font-medium text-ink">
					Create a company
					<ArrowUpRightIcon
						size={12}
						aria-hidden="true"
						class="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
					/>
				</div>
				<p class="mt-1 text-xs leading-5 text-ink-muted">Set up a private space for your team.</p>
				<div aria-hidden="true" class="choice-preview rounded-xl">
					<div
						class="inline-flex size-10 items-center justify-center rounded-button-lg border-hairline border-line bg-canvas text-ink-muted/50"
					>
						<BuildingsIcon size={22} weight="light" />
					</div>
					<div class="mt-5 h-1.5 w-28 rounded-full bg-canvas"></div>
					<div class="mt-2.5 h-1.5 w-44 rounded-full bg-canvas"></div>
					<div class="mt-2.5 h-1.5 w-36 rounded-full bg-canvas"></div>
				</div>
			</div>
		</button>
		<button type="button" class={choiceClass} {disabled} onclick={onjoin}>
			<div class="choice-card rounded-xl">
				<div class="flex items-center gap-1 text-[13px] font-medium text-ink">
					Join your team
					<ArrowUpRightIcon
						size={12}
						aria-hidden="true"
						class="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
					/>
				</div>
				<p class="mt-1 text-xs leading-5 text-ink-muted">
					Already using Dinu? Join by invitation.
				</p>
				<div aria-hidden="true" class="choice-preview rounded-xl">
					<div
						class="inline-flex size-10 items-center justify-center rounded-button-lg border-hairline border-line bg-canvas text-ink-muted/50"
					>
						<UsersIcon size={22} weight="light" />
					</div>
					<div class="mt-5 flex gap-2">
						{#each [1, 2, 3] as person (person)}
							<div
								class="flex size-8 items-center justify-center rounded-full bg-canvas text-ink-muted/30"
							>
								<UsersIcon size={14} weight="light" />
							</div>
						{/each}
					</div>
					<div class="mt-3 h-1.5 w-36 rounded-full bg-canvas"></div>
				</div>
			</div>
		</button>
	</div>
</OnboardingStepFrame>

<style>
	.choice-card {
		position: relative;
		aspect-ratio: 1047 / 605;
		overflow: hidden;
		border: var(--surface-border-width) solid var(--color-edge);
		box-shadow: var(--shadow-card);
		background: var(--color-surface);
		padding: 5.5%;
	}

	.choice-preview {
		position: absolute;
		top: 47%;
		left: 10%;
		width: 110%;
		border: var(--surface-border-width) solid var(--color-line);
		background: var(--color-surface);
		padding: 18px;
		box-shadow: var(--shadow-control);
		transform: rotate(-4.5deg);
		transition: transform 120ms;
	}

	button:hover .choice-preview,
	button:focus-visible .choice-preview {
		transform: rotate(-2.5deg);
	}

	@media (prefers-reduced-motion: reduce) {
		.choice-preview {
			transition: none;
		}
	}
</style>
