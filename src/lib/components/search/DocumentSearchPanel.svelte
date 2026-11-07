<script lang="ts">
	import { onMount, tick } from 'svelte';
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import CaretUpIcon from 'phosphor-svelte/lib/CaretUpIcon';
	import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
	import type { DocumentSearchSession } from '$lib/document/search/search-session.svelte';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';

	let {
		session,
		panelElement = $bindable(),
		inputElement = $bindable()
	}: {
		session: DocumentSearchSession;
		panelElement?: HTMLElement;
		inputElement?: HTMLInputElement;
	} = $props();

	function handleInput(event: Event) {
		session.setQuery((event.currentTarget as HTMLInputElement).value);
	}

	function handleInputKeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		if (event.shiftKey) session.previous();
		else session.next();
	}

	onMount(() => {
		void tick().then(() => inputElement?.focus());
	});
</script>

<section
	bind:this={panelElement}
	id="document-search"
	class="pointer-events-auto w-full rounded-xl border-hairline border-edge bg-surface p-2.5 text-ink shadow-floating"
	aria-label="Search"
	data-utility-panel="document-search"
>
	<label
		class="w-full rounded-button-lg border-hairline border-edge bg-surface px-3 shadow-control outline-none transition-[background-color] focus-within:border-accent focus-within:outline-solid focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent/18 not-disabled:not-aria-disabled:[&:not([readonly])]:not-aria-invalid:hover:not-focus-within:bg-field-hover not-disabled:not-aria-disabled:aria-invalid:border-danger/30 not-disabled:not-aria-disabled:aria-invalid:bg-danger-surface not-disabled:not-aria-disabled:aria-invalid:text-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:border-danger not-disabled:not-aria-disabled:aria-invalid:focus-within:outline-danger/18 motion-reduce:transition-none min-w-0 text-ink aria-disabled:bg-canvas aria-disabled:text-ink-muted flex h-9 items-center gap-2"
	>
		<span class="sr-only">Find in document</span>
		<MagnifyingGlassIcon
			aria-hidden="true"
			weight="regular"
			class="size-[17px] shrink-0 text-ink-muted"
		/>
		<input
			class="min-w-0 text-[13px] placeholder:font-[350] placeholder:text-ink-muted w-full flex-1 border-0 bg-transparent p-0 text-inherit outline-none [&::-webkit-search-cancel-button]:hidden"
			bind:this={inputElement}
			type="search"
			value={session.query}
			placeholder="Find in document"
			autocomplete="off"
			spellcheck="false"
			oninput={handleInput}
			onkeydown={handleInputKeydown}
		/>
	</label>

	{#if session.query}
		<div class="mt-3 flex min-h-9 items-center justify-between">
			<p class="m-0 text-sm leading-[1.4]" role="status" aria-live="polite">
				{#if session.resultCount}
					Result {session.activeResultNumber} of {session.resultCount}
				{:else}
					No results
				{/if}
			</p>

			<div class="flex gap-0.5">
				<SquareIconButton
					type="button"
					aria-label="Previous result"
					disabled={!session.resultCount}
					onclick={() => session.previous()}
				>
					<CaretUpIcon aria-hidden="true" class="size-5" weight="bold" />
				</SquareIconButton>
				<SquareIconButton
					type="button"
					aria-label="Next result"
					disabled={!session.resultCount}
					onclick={() => session.next()}
				>
					<CaretDownIcon aria-hidden="true" class="size-5" weight="bold" />
				</SquareIconButton>
			</div>
		</div>
	{/if}
</section>
