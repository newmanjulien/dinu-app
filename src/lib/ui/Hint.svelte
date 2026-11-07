<script lang="ts">
	import { cn } from './cn';
	import { hints, type HintId } from './hints';

	let {
		id,
		class: className = '',
		role
	}: {
		id: HintId | null;
		class?: string;
		role?: 'status';
	} = $props();
</script>

<p
	{role}
	class={cn(
		'm-0 px-3.5 text-left text-[13px] @min-[1150px]:text-[clamp(12px,0.9cqw,13px)] leading-[1.45] text-ink-muted/60',
		className
	)}
	class:hidden={!id}
>
	{id ? hints[id].text : ''}
</p>
