<script lang="ts">
	import type { HTMLTextareaAttributes } from 'svelte/elements';
	import type { ClassValue } from 'clsx';
	import { cn } from './cn';

	type Props = Omit<HTMLTextareaAttributes, 'value' | 'class' | 'children'> & {
		value?: string;
		class?: ClassValue;
	};

	let { value = $bindable(''), class: className, ...attributes }: Props = $props();
</script>

<textarea
	{...attributes}
	bind:value
	class={cn(
		'block min-h-28 w-full min-w-0 resize-y rounded-button-lg border-hairline border-edge bg-surface px-3 py-2 text-[13px] leading-[1.45] text-ink shadow-control outline-none transition-[background-color] placeholder:font-[350] placeholder:text-ink-muted focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 disabled:bg-canvas disabled:text-ink-muted aria-disabled:bg-canvas aria-disabled:text-ink-muted [&[readonly]]:bg-canvas [&[readonly]]:text-ink-muted motion-reduce:transition-none',
		className
	)}></textarea>
