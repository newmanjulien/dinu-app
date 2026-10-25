import { getContext, setContext, type Snippet } from 'svelte';

const key = Symbol('header-content');
export class HeaderContent {
	content = $state.raw<Snippet>();
	register(content: Snippet) {
		this.content = content;
		return () => {
			if (this.content === content) this.content = undefined;
		};
	}
}
export function setHeaderContent() {
	return setContext(key, new HeaderContent());
}
export function getHeaderContent(): HeaderContent {
	return getContext(key);
}
