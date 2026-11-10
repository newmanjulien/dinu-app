import { getContext, setContext } from 'svelte';
const key = Symbol('document-annotation-label');
export function setAnnotationLabel(label: string) {
	setContext(key, label);
}
export function getAnnotationLabel(): string {
	return getContext(key) ?? 'saved instructions';
}
