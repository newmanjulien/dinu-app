import type { AnnotationActivation } from '../annotation-anchor';
import type { DocumentHighlightController } from './controller';
import { countOverlayWork } from '../runtime/render-perf';

const DRAG_DISTANCE = 5;

interface Gesture {
	pointerId: number;
	x: number;
	y: number;
	owner: HTMLElement | null;
	dragged: boolean;
}

type CompletedGesture =
	| { kind: 'activate-clause'; owner: HTMLElement }
	| { kind: 'activate-background' }
	| { kind: 'ignore' };

/** A resolved document gesture. Workspace policy decides what it means for a panel or editor. */
export type DocumentGestureIntent =
	| {
			kind: 'activate-clause';
			itemId: string;
			annotationId: string;
			activation: AnnotationActivation;
	  }
	| { kind: 'activate-background' };

export type DocumentGesturePolicy = {
	clauseActivation: boolean;
	backgroundActivation: boolean;
};

function isDocumentControl(target: EventTarget | null) {
	return (
		target instanceof Element &&
		Boolean(target.closest('[data-document-control], button, a, input, textarea, select'))
	);
}

export class DocumentGestureInteractions {
	#stage: HTMLElement;
	#highlights: DocumentHighlightController;
	#onIntent: (intent: DocumentGestureIntent) => void;
	#policy: DocumentGesturePolicy = { clauseActivation: false, backgroundActivation: false };
	#pointer: { x: number; y: number } | null = null;
	#gesture: Gesture | null = null;
	#completed: CompletedGesture | null = null;
	#events = new AbortController();
	#unsubscribe: () => void;
	#hoverFrame: number | undefined;

	constructor(
		stage: HTMLElement,
		highlights: DocumentHighlightController,
		onIntent: (intent: DocumentGestureIntent) => void
	) {
		this.#stage = stage;
		this.#highlights = highlights;
		this.#onIntent = onIntent;
		const options = { signal: this.#events.signal };
		stage.addEventListener('pointerdown', this.#down, options);
		stage.addEventListener('pointermove', this.#hoverMove, options);
		stage.addEventListener('pointerleave', this.#leave, options);
		stage.addEventListener('click', this.#click, options);
		window.addEventListener('pointermove', this.#trackMovement, options);
		window.addEventListener('pointerup', this.#up, options);
		window.addEventListener('pointercancel', this.#cancel, options);
		window.addEventListener('blur', this.#cancel, options);
		stage.addEventListener('keydown', () => this.#resetGesture(), options);
		document.addEventListener('scroll', this.#scroll, { ...options, capture: true });
		this.#unsubscribe = highlights.subscribeGeometry((change) => {
			if (change === 'invalidate') {
				this.#cancelHover();
				this.#resetGesture();
				this.#setHover(null);
			} else this.#scheduleHover();
		});
	}

	setPolicy(policy: DocumentGesturePolicy) {
		if (
			this.#policy.clauseActivation === policy.clauseActivation &&
			this.#policy.backgroundActivation === policy.backgroundActivation
		)
			return;
		this.#policy = policy;
		if (!policy.clauseActivation) {
			this.#resetGesture();
			this.#cancelHover();
			this.#setHover(null);
		} else this.#scheduleHover();
	}

	#stageElementAt(x: number, y: number) {
		const element = document.elementFromPoint(x, y);
		return element && this.#stage.contains(element) ? element : null;
	}

	#clauseOwnerAt(x: number, y: number) {
		return this.#stageElementAt(x, y)?.closest<HTMLElement>('.playbook-trigger') ?? null;
	}

	#hit(x: number, y: number) {
		if (!this.#policy.clauseActivation) return null;
		countOverlayWork('hoverChecks');
		// Ignore document regions obscured by a panel or other UI.
		const element = this.#stageElementAt(x, y);
		if (!element) return null;
		const page = element.closest<HTMLElement>('.document-page');
		return page && this.#stage.contains(page) ? this.#highlights.hitTest(page, x, y) : null;
	}

	#ownerAt(x: number, y: number) {
		const owner = this.#clauseOwnerAt(x, y);
		return this.#policy.clauseActivation ? (this.#hit(x, y) ?? owner) : owner;
	}

	#setHover(owner: HTMLElement | null) {
		const annotationId = owner?.dataset.annotationId ?? null;
		this.#highlights.setHoveredAnnotationId(annotationId);
		this.#stage.toggleAttribute('data-clause-hover', annotationId !== null);
	}

	#updateHover = () => {
		this.#setHover(this.#pointer ? this.#hit(this.#pointer.x, this.#pointer.y) : null);
	};
	#scheduleHover = () => {
		if (!this.#policy.clauseActivation || !this.#pointer || this.#hoverFrame !== undefined) return;
		this.#hoverFrame = requestAnimationFrame(() => {
			this.#hoverFrame = undefined;
			this.#updateHover();
		});
	};
	#cancelHover() {
		if (this.#hoverFrame !== undefined) cancelAnimationFrame(this.#hoverFrame);
		this.#hoverFrame = undefined;
	}

	#down = (event: PointerEvent) => {
		this.#resetGesture();
		if (
			event.defaultPrevented ||
			(!this.#policy.clauseActivation && !this.#policy.backgroundActivation) ||
			!event.isPrimary ||
			event.button !== 0
		)
			return;
		const owner = this.#ownerAt(event.clientX, event.clientY);
		this.#gesture = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			owner,
			dragged: false
		};
		if (event.pointerType !== 'touch') {
			this.#cancelHover();
			this.#pointer = { x: event.clientX, y: event.clientY };
			this.#setHover(owner);
		}
	};

	#trackMovement = (event: PointerEvent) => {
		const gesture = this.#gesture;
		if (
			gesture?.pointerId === event.pointerId &&
			Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > DRAG_DISTANCE
		)
			gesture.dragged = true;
	};

	#hoverMove = (event: PointerEvent) => {
		if (!this.#policy.clauseActivation || !event.isPrimary || event.pointerType === 'touch') return;
		this.#pointer = { x: event.clientX, y: event.clientY };
		this.#scheduleHover();
	};

	#up = (event: PointerEvent) => {
		this.#trackMovement(event);
		const gesture = this.#gesture;
		if (!gesture || gesture.pointerId !== event.pointerId) return;
		this.#gesture = null;
		const owner = this.#ownerAt(event.clientX, event.clientY);
		if (
			gesture.dragged ||
			event.button !== 0 ||
			!this.#stageElementAt(event.clientX, event.clientY)
		) {
			this.#completed = { kind: 'ignore' };
			return;
		}
		if (gesture.owner)
			this.#completed =
				owner === gesture.owner ? { kind: 'activate-clause', owner } : { kind: 'ignore' };
		else this.#completed = owner ? { kind: 'ignore' } : { kind: 'activate-background' };
	};

	#hasStageTextSelection() {
		const selection = document.getSelection();
		return Boolean(
			selection &&
			!selection.isCollapsed &&
			selection.anchorNode &&
			selection.focusNode &&
			this.#stage.contains(selection.anchorNode) &&
			this.#stage.contains(selection.focusNode)
		);
	}

	#click = (event: MouseEvent) => {
		const completed = this.#completed;
		this.#resetGesture();
		// A completed native selection inside the document is the same click-away as its background.
		if (this.#hasStageTextSelection()) {
			if (
				completed &&
				this.#policy.backgroundActivation &&
				!event.defaultPrevented &&
				!isDocumentControl(event.target)
			)
				this.#onIntent({ kind: 'activate-background' });
			return;
		}
		if (
			(!this.#policy.clauseActivation && !this.#policy.backgroundActivation) ||
			event.defaultPrevented ||
			event.detail > 1
		)
			return;
		if (event.detail === 0) {
			if (!this.#policy.clauseActivation || isDocumentControl(event.target)) return;
			const owner =
				event.target instanceof Element
					? event.target.closest<HTMLElement>('.playbook-trigger')
					: null;
			if (owner) this.#activateClause(owner, { owner });
			return;
		}
		if (completed?.kind === 'activate-clause' && this.#policy.clauseActivation) {
			this.#activateClause(completed.owner, {
				owner: completed.owner,
				clientX: event.clientX,
				clientY: event.clientY
			});
		} else if (
			completed?.kind === 'activate-background' &&
			this.#policy.backgroundActivation &&
			!isDocumentControl(event.target)
		) {
			this.#onIntent({ kind: 'activate-background' });
		}
	};

	#activateClause(owner: HTMLElement, activation: AnnotationActivation) {
		if (!owner.isConnected || !this.#stage.contains(owner)) return;
		const { itemId, annotationId } = owner.dataset;
		if (itemId && annotationId)
			this.#onIntent({ kind: 'activate-clause', itemId, annotationId, activation });
	}

	#resetGesture() {
		this.#gesture = null;
		this.#completed = null;
	}

	#leave = () => {
		this.#cancelHover();
		this.#pointer = null;
		this.#setHover(null);
	};

	#cancel = () => {
		this.#resetGesture();
		this.#leave();
	};

	#scroll = () => {
		this.#resetGesture();
		this.#scheduleHover();
	};

	destroy() {
		this.#events.abort();
		this.#unsubscribe();
		this.#cancel();
	}
}
