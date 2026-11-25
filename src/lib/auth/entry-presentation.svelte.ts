import { getContext, setContext } from 'svelte';

const key = Symbol('entryPresentation');
export class EntryPresentation {
	showFooter = $state(true);
	createAccountStep = $state<1 | 2>();
}
export const setEntryPresentation = () => setContext(key, new EntryPresentation());
export const useEntryPresentation = () => getContext<EntryPresentation>(key);
