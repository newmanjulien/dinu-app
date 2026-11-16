import { getContext, setContext } from 'svelte';

class ContractsSearch {
	value = $state('');
	query = $state('');
	visited = false;
	viewQuery = '';
	contractRows = 4;
	buyerLinks = 10;
	private restore = false;
	private selection: [number, number] | undefined;

	rememberFocus(input: HTMLInputElement) {
		if (typeof document === 'undefined' || document.activeElement !== input) return;
		this.restore = true;
		this.selection = [
			input.selectionStart ?? input.value.length,
			input.selectionEnd ?? input.value.length
		];
	}

	restoreFocus(input: HTMLInputElement) {
		if (!this.restore) return;
		this.restore = false;
		queueMicrotask(() => {
			if (!input.isConnected) return;
			input.focus({ preventScroll: true });
			if (this.selection) input.setSelectionRange(...this.selection);
		});
	}
}

const key = Symbol('contracts-search');
export const setContractsSearch = () => setContext(key, new ContractsSearch());
export const useContractsSearch = () => getContext<ContractsSearch | undefined>(key);
