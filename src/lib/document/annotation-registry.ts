import { getContext, setContext } from 'svelte';
import type { SourceRange, SourceTarget } from '../contract/source-model';
import type { ResolvedRun } from '../contract/model';

export type AnnotationSegment = {
	source?: SourceRange;
	visualSource?: SourceTarget;
	generated?: ResolvedRun['generated'];
	generatedStart?: number;
	generatedEnd?: number;
};
export type ProjectedOccurrence = {
	ranges: readonly Range[];
	segments: readonly AnnotationSegment[];
	prepare: () => void;
};

const ANNOTATIONS = Symbol('mounted-annotation-targets');

/** Only mounted owners are retained; component destruction removes every registration. */
export class AnnotationRegistry {
	private owners = new Map<string, Set<HTMLElement>>();
	private projected = new Map<HTMLElement, ProjectedOccurrence>();
	private focusing = false;

	get programmaticFocus() {
		return this.focusing;
	}
	occurrence(owner: HTMLElement) {
		return this.projected.get(owner);
	}
	updateOccurrence(owner: HTMLElement, occurrence: ProjectedOccurrence) {
		this.projected.set(owner, occurrence);
	}
	focus(owner: HTMLElement) {
		const previous = this.focusing;
		this.focusing = true;
		try {
			this.projected.get(owner)?.prepare();
			owner.focus({ preventScroll: true });
		} finally {
			this.focusing = previous;
		}
	}

	register(owner: HTMLElement, memberships: readonly string[]) {
		for (const id of memberships) {
			let group = this.owners.get(id);
			if (!group) this.owners.set(id, (group = new Set()));
			group.add(owner);
		}
		return () => {
			this.projected.delete(owner);
			for (const id of memberships) {
				const group = this.owners.get(id);
				group?.delete(owner);
				if (!group?.size) this.owners.delete(id);
			}
		};
	}

	forAnnotation(id: string): HTMLElement[] {
		return [...(this.owners.get(id) ?? [])]
			.filter((owner) => owner.isConnected)
			.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
	}

	clear() {
		this.owners.clear();
		this.projected.clear();
	}
}

export const setAnnotationRegistry = () => setContext(ANNOTATIONS, new AnnotationRegistry());
export const getAnnotationRegistry = () => getContext<AnnotationRegistry | undefined>(ANNOTATIONS);
