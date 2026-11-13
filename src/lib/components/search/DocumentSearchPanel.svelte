<script lang="ts">
	import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
	import CaretUpIcon from 'phosphor-svelte/lib/CaretUpIcon';
	import SearchField from '$lib/ui/SearchField.svelte';
	import type { DocumentSearchSession } from '$lib/document/search/search-session.svelte';
	import SquareIconButton from '$lib/components/ui/SquareIconButton.svelte';

	let {
		session,
		inputElement = $bindable()
	}: {
		session: DocumentSearchSession;
		inputElement?: HTMLInputElement | null;
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
</script>

<SearchField
	bind:element={inputElement}
	label="Find in document"
	value={session.query}
	placeholder="Find in document"
	autocomplete="off"
	spellcheck="false"
	clearable={false}
	oninput={handleInput}
	onkeydown={handleInputKeydown}
/>

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
