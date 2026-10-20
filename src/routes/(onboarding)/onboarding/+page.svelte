<script lang="ts">
	import RequireAccount from '$lib/auth/RequireAccount.svelte';
	import OnboardingFlow from '$lib/auth/onboarding/OnboardingFlow.svelte';
</script>

<RequireAccount inline>
	<OnboardingFlow />
</RequireAccount>
