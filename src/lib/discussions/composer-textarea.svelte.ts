import { untrack } from 'svelte';
import type { Attachment } from 'svelte/attachments';
import { focusComposer } from './focus-composer';
import { autosizeTextarea } from './textarea-autosize';

/** Keep focus and measurement on the native node supplied by the shared field. */
export function composerTextarea(value: () => string): Attachment<HTMLTextAreaElement> {
	return (element) => {
		const focus = focusComposer(element);
		const size = autosizeTextarea(element, { value: untrack(value), maxHeight: 160 });
		$effect(() => size?.update?.({ value: value(), maxHeight: 160 }));
		return () => {
			focus?.destroy?.();
			size?.destroy?.();
		};
	};
}
