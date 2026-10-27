<script lang="ts">
	import AuthButton from './AuthButton.svelte';
	import AuthStepFrame from './AuthStepFrame.svelte';
	import AuthTextInput from './AuthTextInput.svelte';

	type Props = {
		email: string;
		description?: string;
		code: string;
		errorText: string | null;
		isSubmitting: boolean;
		isResending: boolean;
		onSubmit: () => void;
		onResend: () => void;
		onChangeEmail?: () => void;
	};

	let {
		email,
		description,
		code = $bindable(),
		errorText,
		isSubmitting,
		isResending,
		onSubmit,
		onResend,
		onChangeEmail
	}: Props = $props();
	const canSubmit = $derived(code.trim().length > 0 && !isSubmitting);
</script>

<AuthStepFrame title="Enter your code" {description}>
	<form
		class="grid gap-3.5"
		onsubmit={(event) => {
			event.preventDefault();
			if (canSubmit) {
				onSubmit();
			}
		}}
	>
		<p class="m-0 text-sm leading-5 text-ink-muted">
			Sent a code to {email}
		</p>
		<AuthTextInput
			label="Verification code"
			bind:value={code}
			autocomplete="one-time-code"
			inputmode="numeric"
			required
			autofocus
		/>
		{#if errorText}
			<p role="alert" class="m-0 text-sm leading-5 text-danger">{errorText}</p>
		{/if}
		<AuthButton type="submit" disabled={!canSubmit}>
			{isSubmitting ? 'Checking...' : 'Continue'}
		</AuthButton>
		<div class="flex items-center justify-between gap-3 text-[13px] leading-5">
			{#if onChangeEmail}<button
					type="button"
					class="cursor-pointer rounded-button-sm text-ink-muted underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
					onclick={onChangeEmail}
				>
					Change email
				</button>{/if}
			<button
				type="button"
				class="cursor-pointer rounded-button-sm text-ink-muted underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:text-ink-muted"
				disabled={isResending}
				onclick={onResend}
			>
				{isResending ? 'Sending...' : 'Resend code'}
			</button>
		</div>
	</form>
</AuthStepFrame>
