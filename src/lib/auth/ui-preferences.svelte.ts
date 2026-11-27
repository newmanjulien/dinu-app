import type { OptimisticLocalStore } from 'convex/browser';
import { getContext, setContext } from 'svelte';
import { api } from '../../convex/_generated/api';
import { useReadQuery } from './read-query.svelte';
const key = Symbol('ui-preferences');
export function setUiPreferences(query: ReturnType<typeof createUiPreferences>) {
	return setContext(key, query);
}
export function createUiPreferences() {
	return useReadQuery(api.accounts.uiPreferences, {});
}
export function useUiPreferences() {
	return getContext<ReturnType<typeof createUiPreferences>>(key);
}

export function optimisticCollapsed(store: OptimisticLocalStore, collapsed: boolean) {
	const current = store.getQuery(api.accounts.uiPreferences, {});
	if (current)
		store.setQuery(
			api.accounts.uiPreferences,
			{},
			{ ...current, supportWidgetCollapsed: collapsed }
		);
}
export function optimisticHelp(
	store: OptimisticLocalStore,
	variant: 'contract' | 'buyerLink',
	hidden: boolean
) {
	const current = store.getQuery(api.accounts.uiPreferences, {});
	if (current)
		store.setQuery(
			api.accounts.uiPreferences,
			{},
			{ ...current, helpPreferences: { ...current.helpPreferences, [variant]: hidden } }
		);
}
