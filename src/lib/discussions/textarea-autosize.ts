import type { Action } from 'svelte/action';

export interface TextareaAutosizeOptions {
	value: string;
	maxHeight: number;
}

export const autosizeTextarea: Action<HTMLTextAreaElement, TextareaAutosizeOptions> = (
	element,
	initialOptions
) => {
	let options = initialOptions;
	let observedWidth = element.offsetWidth;

	function resize() {
		element.style.height = 'auto';
		const borderHeight = element.offsetHeight - element.clientHeight;
		const contentHeight = element.scrollHeight + borderHeight;
		element.style.height = `${Math.min(contentHeight, options.maxHeight)}px`;
		element.style.overflowY = contentHeight > options.maxHeight ? 'auto' : 'hidden';
	}

	resize();

	const resizeObserver =
		typeof ResizeObserver === 'undefined'
			? undefined
			: new ResizeObserver(() => {
					const width = element.offsetWidth;
					if (width === observedWidth) return;
					observedWidth = width;
					resize();
				});
	resizeObserver?.observe(element);

	return {
		update(nextOptions) {
			if (options.value === nextOptions.value && options.maxHeight === nextOptions.maxHeight)
				return;
			options = nextOptions;
			if (element.value !== options.value) element.value = options.value;
			resize();
		},
		destroy() {
			resizeObserver?.disconnect();
		}
	};
};
