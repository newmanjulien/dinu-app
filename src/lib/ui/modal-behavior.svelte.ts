import { untrack } from 'svelte';
import { getInteractionController } from '$lib/components/ui/interactions';

let activeScrollLocks = 0;
let previousBodyOverflow = '';

type ModalBehaviorOptions = {
	isOpen: () => boolean;
	onOpen?: () => void;
};

export function createModalBehavior({ isOpen, onOpen }: ModalBehaviorOptions) {
	const interactions = getInteractionController();
	let dialogElement = $state<HTMLDialogElement | undefined>();

	$effect(() => {
		const element = dialogElement;
		if (!element || !isOpen()) return;

		return untrack(() => {
			interactions?.closeTransient();
			const previouslyFocusedElement =
				document.activeElement instanceof HTMLElement ? document.activeElement : null;
			element.showModal();
			lockBodyScroll();

			const cleanup = () => {
				const shouldRestoreFocus =
					element.contains(document.activeElement) || document.activeElement === document.body;
				element.close();
				unlockBodyScroll();
				if (shouldRestoreFocus && previouslyFocusedElement?.isConnected) {
					previouslyFocusedElement.focus({ preventScroll: true });
				}
			};

			try {
				element.focus({ preventScroll: true });
				onOpen?.();
			} catch (error) {
				cleanup();
				throw error;
			}

			return cleanup;
		});
	});

	return {
		get dialogElement() {
			return dialogElement;
		},
		set dialogElement(element: HTMLDialogElement | undefined) {
			dialogElement = element;
		}
	};
}

function lockBodyScroll() {
	if (activeScrollLocks === 0) {
		previousBodyOverflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
	}
	activeScrollLocks += 1;
}

function unlockBodyScroll() {
	activeScrollLocks = Math.max(0, activeScrollLocks - 1);
	if (activeScrollLocks === 0) {
		document.body.style.overflow = previousBodyOverflow;
		previousBodyOverflow = '';
	}
}
