import type { RenderSnapshot } from './types';
import type { PaginatedPage } from '../pagination/types';
import type { SelectionDocument } from '../selection/selection-model';

/** The page DOM that has settled after a render commit. */
export type MountedDocumentRevision = {
	id: number;
	generation: number;
	layoutEpoch: string;
	pages: readonly PaginatedPage[];
	selectionDocument?: SelectionDocument;
};

export function matchesMountedSnapshot(
	revision: MountedDocumentRevision | null,
	snapshot: RenderSnapshot | null | undefined
): boolean {
	return Boolean(
		revision &&
		snapshot &&
		revision.generation === snapshot.id &&
		revision.layoutEpoch === snapshot.layoutEpoch &&
		revision.selectionDocument === snapshot.selectionDocument &&
		revision.pages.length === snapshot.pages.length &&
		revision.pages.every((page, i) => page === snapshot.pages[i])
	);
}
export type ExactDisplay = Pick<
	RenderSnapshot,
	'source' | 'concessions' | 'previewChanges' | 'layoutEpoch'
> & { readonly generation: number };
/** First page contents mounted in the visible stage after the DOM update. */
export type FirstPagesReady = Pick<ExactDisplay, 'generation' | 'layoutEpoch' | 'source'> & {
	readonly pages: readonly PaginatedPage[];
};
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
	mountedDomRevision = $state.raw<MountedDocumentRevision | null>(null);
	firstPagesReady = $state.raw<FirstPagesReady | null>(null);
	interactionEnabled = $state(false);
	layoutPrepared = $state(false);
	pagesVisible = $state(false);
	preparationBlocked = $state(false);
}
