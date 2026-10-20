<script lang="ts">
	import OnboardingStepFrame from './OnboardingStepFrame.svelte';
	import AuthTextInput from '../components/AuthTextInput.svelte';
	import AuthButton from '../components/AuthButton.svelte';

	let {
		name = $bindable(''),
		pending,
		blocked,
		error,
		onsubmit
	}: {
		name: string;
		pending: boolean;
		blocked: boolean;
		error: string;
		onsubmit: (name: string) => void;
	} = $props();
</script>

<OnboardingStepFrame
	title="About your company"
	description="Create a private company to manage contracts with your colleagues."
>
	<form
		class="mx-auto grid max-w-85 gap-3.5 text-left"
		onsubmit={(event) => {
			event.preventDefault();
			if (name.trim() && !pending && !blocked) onsubmit(name.trim());
		}}
	>
		<AuthTextInput
			label="Your company's name"
			bind:value={name}
			autocomplete="organization"
			maxlength={120}
			required
			autofocus
			disabled={pending || blocked}
		/>
		<AuthButton type="submit" disabled={pending || blocked || !name.trim()}
			>{pending ? 'Creating…' : 'Create company'}</AuthButton
		>
		<p class="m-0 text-center text-xs leading-5 text-[#8f9297]">
			You can invite your colleagues once your company is set up.
		</p>
		{#if error}<p role="alert" class="text-center text-sm leading-5 text-danger">{error}</p>{/if}
	</form>
</OnboardingStepFrame>
