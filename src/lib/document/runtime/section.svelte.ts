import { getContext, setContext } from 'svelte';

const key = Symbol('document-section');

/** The scroll surface owned by one mounted document section. */
export interface DocumentSectionHandle {
	readonly identity: symbol;
	readonly viewport: HTMLElement | undefined;
	readonly active: boolean;
}

export function setDocumentSection(section: DocumentSectionHandle): DocumentSectionHandle {
	return setContext(key, section);
}

export function getDocumentSection(): DocumentSectionHandle | undefined {
	return getContext(key);
}
