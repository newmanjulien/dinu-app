import { getContext, setContext } from 'svelte';

const key = Symbol('entryPresentation');
export class EntryPresentation {
	showFooter = $state(true);
	signupStep = $state<1 | 2 | 3>();
}
export const setEntryPresentation = () => setContext(key, new EntryPresentation());
export const useEntryPresentation = () => getContext<EntryPresentation>(key);
