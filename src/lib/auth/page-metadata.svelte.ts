import { getContext, setContext } from 'svelte';

const key = Symbol('page-metadata');
export class PageMetadata {
	override = $state.raw<{ title: string; routeId: string | null }>();
	register(title: string, routeId: string | null) {
		const value = { title, routeId };
		this.override = value;
		return () => {
			if (this.override === value) this.override = undefined;
		};
	}
}
export function setPageMetadata() {
	return setContext(key, new PageMetadata());
}
export function getPageMetadata(): PageMetadata {
	return getContext(key);
}
