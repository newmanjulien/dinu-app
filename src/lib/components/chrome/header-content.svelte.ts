import { getContext, setContext, type Snippet } from 'svelte';

const key = Symbol('header-content');
export class HeaderContent {
	content = $state.raw<Snippet>();
	notice = $state.raw<Snippet>();
	register(content: Snippet, placement: 'overlay' | 'notice' = 'overlay') {
		const target = placement === 'notice' ? 'notice' : 'content';
		this[target] = content;
		return () => {
			if (this[target] === content) this[target] = undefined;
		};
	}
}
export function setHeaderContent() {
	return setContext(key, new HeaderContent());
}
export function getHeaderContent(): HeaderContent {
	return getContext(key);
}
