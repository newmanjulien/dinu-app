<script lang="ts">
	let {
		label,
		checked,
		onCheckedChange,
		disabled = false,
		className = ''
	}: {
		label: string;
		checked: boolean;
		onCheckedChange: (checked: boolean) => void;
		disabled?: boolean;
		className?: string;
	} = $props();
</script>

<label
	class={`flex cursor-pointer items-start gap-2 text-[14px] leading-5 text-ink-muted has-[:disabled]:cursor-default has-[:disabled]:opacity-50 ${className}`}
>
	<input
		type="checkbox"
		{checked}
		onchange={(event) => onCheckedChange(event.currentTarget.checked)}
		class="peer sr-only"
		{disabled}
	/>
	<span
		class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-control-border bg-surface transition-colors
			peer-checked:border-ink peer-checked:bg-ink
			peer-checked:[&>svg]:opacity-100
			peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent"
		aria-hidden="true"
	>
		<svg class="h-3 w-3 text-surface opacity-0 transition-opacity" viewBox="0 0 12 12" fill="none">
			<path
				d="M2.5 6.25L4.8 8.4L9.5 3.6"
				stroke="currentColor"
				stroke-width="1.8"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</svg>
	</span>
	<span class="min-w-0">{label}</span>
</label>
