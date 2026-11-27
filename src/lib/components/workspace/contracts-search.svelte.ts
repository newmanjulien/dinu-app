import { getContext, setContext } from 'svelte';

export const HOME_SEARCH_SETTLE_MS = 500;

export class ContractsSearchSession {
	value = $state('');
	query = $state('');
	viewQuery = '';
	contractRows = 4;
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

class ContractsSearch {
	visited = false;

	constructor(private session: () => ContractsSearchSession | undefined) {}

	get current() {
		return this.session();
	}
}

const key = Symbol('contracts-search');
export const setContractsSearch = (session: () => ContractsSearchSession | undefined) =>
	setContext(key, new ContractsSearch(session));
export const useContractsSearch = () => getContext<ContractsSearch | undefined>(key);
