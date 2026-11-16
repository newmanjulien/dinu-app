import { getContext, setContext } from 'svelte';
import type { Id } from '../../../convex/_generated/dataModel';
import { FirstLinkHintVisit } from '$lib/buyer/first-link-hint-visit.svelte';

export class ContractsSearchSession {
	value = $state('');
	query = $state('');
	viewQuery = '';
	contractRows = 4;
	buyerLinks = 10;
	private restore = false;
	private selection: [number, number] | undefined;
	private hintVisit: FirstLinkHintVisit | undefined;

	firstLinkHintVisit(membershipId: Id<'memberships'>) {
		if (this.hintVisit?.membershipId !== membershipId)
			this.hintVisit = new FirstLinkHintVisit(membershipId);
		return this.hintVisit;
	}

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
