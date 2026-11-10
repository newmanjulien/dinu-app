import type { RenderSnapshot } from './types';
/** Published by the mounted viewer; consumers share its interaction readiness. */
export class DocumentViewerState {
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
