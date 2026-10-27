import { getContext, setContext } from 'svelte';

export type CloseReason =
	'escape' | 'outside-pointer' | 'focus-leaving' | 'activation' | 'anchor-removal';
export type InteractionKind = 'tooltip' | 'surface' | 'utility' | 'panel';
export interface Interaction {
	id: symbol;
	owner?: symbol;
	kind: InteractionKind;
	elements: () => readonly (HTMLElement | undefined)[];
	close: (reason: CloseReason) => void;
	dismissOnFocus?: boolean;
	visible?: () => boolean;
}

const controllerKey = Symbol('interaction-controller');
const ownerKey = Symbol('interaction-owner');
const inputCaptureKey = Symbol('interaction-input-capture');

/** One app-owned dispatcher. Registrations request dismissal; owners decide whether it is allowed. */
export class InteractionController {
	private entries = new Map<symbol, Interaction & { order: number }>();
	private boundaries = new Set<{ element: HTMLElement; owner: symbol }>();
	private shortcuts = new Set<(event: KeyboardEvent) => void>();
	private order = 0;

	register(interaction: Interaction) {
		this.entries.set(interaction.id, { ...interaction, order: ++this.order });
		return () => {
			for (const child of this.descendants(interaction.id)) child.close('anchor-removal');
			this.entries.delete(interaction.id);
		};
	}

	protect(element: HTMLElement, owner: symbol) {
		const boundary = { element, owner };
		this.boundaries.add(boundary);
		return () => this.boundaries.delete(boundary);
	}

	shortcut(handler: (event: KeyboardEvent) => void) {
		this.shortcuts.add(handler);
		return () => this.shortcuts.delete(handler);
	}

	modalOpen() {
		return Boolean(document.querySelector('dialog:modal'));
	}

	closeTransient() {
		for (const entry of this.sorted()) {
			if (entry.kind !== 'panel') entry.close('outside-pointer');
		}
	}

	private ownedBy(entry: Interaction, owner: symbol): boolean {
		const seen = new Set<symbol>();
		for (let parent = entry.owner; parent && !seen.has(parent);) {
			if (parent === owner) return true;
			seen.add(parent);
			parent = this.entries.get(parent)?.owner;
		}
		return false;
	}

	private descendants(owner: symbol) {
		return this.sorted().filter((entry) => this.ownedBy(entry, owner));
	}

	private sorted() {
		return [...this.entries.values()].sort((a, b) => b.order - a.order);
	}

	private contains(entry: Interaction, path: readonly EventTarget[]) {
		const family = [entry, ...this.descendants(entry.id)];
		const owners = new Set(family.map((member) => member.id));
		const elements = [
			...family.flatMap((member) => member.elements()),
			...[...this.boundaries]
				.filter((boundary) => owners.has(boundary.owner))
				.map((boundary) => boundary.element)
		];
		return elements.some(
			(element) => element && path.some((node) => node instanceof Node && element.contains(node))
		);
	}

	private trackInteraction(path: readonly EventTarget[]) {
		// Snapshot membership before dismissal and mark containing interactions active.
		const interactions = this.sorted().map((entry) => ({
			entry,
			inside: this.contains(entry, path)
		}));
		for (const { entry, inside } of [...interactions].reverse()) {
			if (inside) entry.order = ++this.order;
		}
		return interactions;
	}

	mount() {
		const listeners = new AbortController();
		const options = { signal: listeners.signal };
		document.addEventListener(
			'pointerdown',
			(event) => {
				if (event.button !== 0 || this.modalOpen()) return;
				for (const { entry, inside } of this.trackInteraction(event.composedPath())) {
					if (!inside) entry.close('outside-pointer');
				}
			},
			options
		);
		document.addEventListener(
			'focusin',
			(event) => {
				if (this.modalOpen()) return;
				for (const { entry, inside } of this.trackInteraction(event.composedPath())) {
					if (!inside && entry.dismissOnFocus) entry.close('focus-leaving');
				}
			},
			options
		);
		document.addEventListener(
			'keydown',
			(event) => {
				if (event.defaultPrevented || this.modalOpen()) return;
				if (event.key === 'Escape') {
					const entries = this.sorted().filter((entry) => entry.visible?.() ?? true);
					const target =
						entries.find((entry) => entry.kind === 'tooltip') ??
						entries.find((entry) => entry.kind !== 'panel') ??
						entries.find((entry) => entry.kind === 'panel');
					if (target) {
						event.preventDefault();
						event.stopPropagation();
						target.close('escape');
					}
					return;
				}
				for (const shortcut of this.shortcuts) shortcut(event);
			},
			{ ...options, capture: true }
		);
		return () => listeners.abort();
	}
}

export function setInteractionController(controller: InteractionController) {
	return setContext(controllerKey, controller);
}
export function getInteractionController(): InteractionController {
	return getContext(controllerKey);
}
export function setInteractionOwner(owner: symbol) {
	return setContext(ownerKey, owner);
}
export function getInteractionOwner(): symbol | undefined {
	return getContext(ownerKey);
}

/** Portaled surfaces still report input to their logical workspace before handling it. */
export function setInteractionInputCapture(capture: (event: Event) => void) {
	return setContext(inputCaptureKey, capture);
}
export function getInteractionInputCapture(): ((event: Event) => void) | undefined {
	return getContext(inputCaptureKey);
}

/** Capture context at component initialization, then attach real boundaries without selector exemptions. */
export function protectedInteraction() {
	const controller = getInteractionController();
	const owner = getInteractionOwner();
	return (element: HTMLElement, enabled = true) => {
		let release: (() => void) | undefined;
		const update = (next = true) => {
			release?.();
			release = next && owner ? controller.protect(element, owner) : undefined;
		};
		update(enabled);
		return { update, destroy: () => release?.() };
	};
}
