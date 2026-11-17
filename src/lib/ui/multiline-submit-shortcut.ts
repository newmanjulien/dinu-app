export function multilineSubmitShortcut(submit: () => void) {
	let composing = false;
	let compositionEndedAt = -Infinity;

	return {
		keydown(event: KeyboardEvent) {
			if (composing || event.isComposing || event.keyCode === 229) {
				if (event.key === 'Escape') event.stopPropagation();
				return;
			}
			// Some IMEs send a final Enter keydown after compositionend with isComposing false.
			if (event.key === 'Enter' && performance.now() - compositionEndedAt < 200) {
				event.preventDefault();
				return;
			}
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				submit();
			}
		},
		compositionStart() {
			composing = true;
		},
		compositionEnd() {
			composing = false;
			compositionEndedAt = performance.now();
		}
	};
}
