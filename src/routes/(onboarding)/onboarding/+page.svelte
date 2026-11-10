<script lang="ts">
	import RequireAccount from '$lib/auth/RequireAccount.svelte';
	import OnboardingFlow from '$lib/auth/onboarding/OnboardingFlow.svelte';
	import OnboardingSkeleton from '$lib/auth/onboarding/OnboardingSkeleton.svelte';
</script>

<RequireAccount inline>
	{#snippet loading({ announce })}<OnboardingSkeleton {announce} />{/snippet}
	<OnboardingFlow />
</RequireAccount>
