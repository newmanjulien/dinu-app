import type { RenderSnapshot } from './types';
export type ExactDisplay = Pick<
	RenderSnapshot,
	'source' | 'concessions' | 'previewChanges' | 'layoutEpoch'
> & { readonly generation: number };
/** Published by the mounted viewer; consumers share its interaction readiness. */
export class DocumentViewerState {
	#exactDisplay = $state.raw<ExactDisplay | null>(null);
	get exactDisplay() {
		return this.#exactDisplay;
	}
	/** Only the mounted viewer publishes DOM display identity; this is not a complete snapshot. */
	publishExactDisplay(display: ExactDisplay | null) {
		this.#exactDisplay = display;
	}
	documentStageElement = $state<HTMLDivElement | null>();
	retry = $state<() => void>();
	restoreAnnotationFocus = $state<() => void>();
	captureAnnotationFocus = $state<() => () => void>();
	displayedSnapshot = $state.raw<RenderSnapshot | null>(null);
	interactionEnabled = $state(false);
	layoutPrepared = $state(false);
	pagesVisible = $state(false);
	preparationBlocked = $state(false);
}
