import {
	autoUpdate,
	computePosition,
	flip,
	hide,
	offset,
	shift,
	size,
	type Placement,
	type VirtualElement
} from '@floating-ui/dom';
import type { CloseReason } from './interactions';
import { countOverlayWork } from '$lib/document/runtime/render-perf';

export type FloatingVirtualAnchor = VirtualElement & {
	subscribe?: (update: () => void) => () => void;
};
export type FloatingAnchor = HTMLElement | FloatingVirtualAnchor;
export interface FloatingOptions {
	anchor: FloatingAnchor;
	placement: Placement;
	gap: number;
	matchWidth: boolean;
	maxWidth?: number;
	referenceClipping: 'ignore' | 'hide' | 'close';
	close: (reason: CloseReason) => void;
	onReady?: () => void;
}

type AnchorWatch = { context: Element; update: () => void };
const anchorObservers = new WeakMap<
	Document,
	{
		observer: MutationObserver;
		watches: Set<AnchorWatch>;
	}
>();

/** One removal observer per document, active only while surfaces own references. */
function watchAnchor(context: Element, update: () => void) {
	const document = context.ownerDocument;
	let shared = anchorObservers.get(document);
	if (!shared) {
		const watches = new Set<AnchorWatch>();
		const observer = new MutationObserver((records) => {
			for (const watch of watches) {
				const affected = records.some((record) =>
					record.type === 'attributes'
						? record.oldValue !== (record.target as Element).getAttribute(record.attributeName!) &&
							record.target.contains(watch.context)
						: Array.from(record.removedNodes).some((node) => node.contains(watch.context))
				);
				if (affected) watch.update();
			}
		});
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeOldValue: true,
			attributeFilter: ['disabled', 'hidden', 'inert', 'class', 'style']
		});
		shared = { observer, watches };
		anchorObservers.set(document, shared);
	}
	const owner = shared;
	const watch = { context, update };
	owner.watches.add(watch);
	return () => {
		if (!owner.watches.delete(watch)) return;
		if (!owner.watches.size) {
			owner.observer.disconnect();
			anchorObservers.delete(document);
		}
	};
}

/** Older browsers need a viewport host to escape transformed and clipping ancestors. */
function fallbackLayer(surface: HTMLElement) {
	const document = surface.ownerDocument;
	const parent = surface.parentElement!;
	const host = parent.closest('dialog[open]') ?? document.body;
	const marker = document.createComment('floating-surface');
	const scope = document.createElement('fieldset');
	scope.style.display = 'contents';
	let copiedVariables = new Set<string>();
	const syncBlocking = () => {
		let disabled = false;
		for (let ancestor: HTMLElement | null = parent; ancestor; ancestor = ancestor.parentElement) {
			if (
				ancestor instanceof HTMLFieldSetElement &&
				ancestor.disabled &&
				!ancestor.querySelector(':scope > legend')?.contains(marker)
			)
				disabled = true;
		}
		scope.disabled = disabled;
		scope.inert = Boolean(parent.closest('[inert]'));
	};
	const sync = () => {
		const inherited = getComputedStyle(parent);
		const destination = getComputedStyle(host);
		for (const property of [
			'color',
			'direction',
			'font-family',
			'font-size',
			'font-style',
			'font-weight',
			'letter-spacing',
			'line-height',
			'text-align',
			'text-transform'
		])
			scope.style.setProperty(property, inherited.getPropertyValue(property));
		const nextVariables = new Set<string>();
		for (let i = 0; i < inherited.length; i++) {
			const property = inherited[i];
			if (!property.startsWith('--')) continue;
			const value = inherited.getPropertyValue(property);
			if (value === destination.getPropertyValue(property)) continue;
			nextVariables.add(property);
			scope.style.setProperty(property, value);
		}
		for (const property of copiedVariables) {
			if (!nextVariables.has(property)) scope.style.removeProperty(property);
		}
		copiedVariables = nextVariables;
	};
	parent.insertBefore(marker, surface);
	syncBlocking();
	sync();
	const zIndex = surface.style.zIndex;
	surface.style.zIndex = '1000';
	scope.append(surface);
	host.append(scope);
	return {
		sync,
		syncBlocking,
		close() {
			surface.style.visibility = 'hidden';
			surface.style.zIndex = zIndex;
			// Svelte may remove the surface or its original subtree before effect cleanup.
			if (surface.parentNode === scope && marker.isConnected) marker.replaceWith(surface);
			else {
				surface.remove();
				marker.remove();
			}
			scope.remove();
		}
	};
}

/** Native popovers preserve DOM ownership; the fallback mirrors its inherited scope. */
export function positionFloating(surface: HTMLElement, options: FloatingOptions) {
	const { anchor, close } = options;
	const context = anchor instanceof HTMLElement ? anchor : anchor.contextElement;
	let disposed = false;
	let ready = false;
	let revision = 0;
	let frame: number | undefined;
	let stylesChanged = false;
	Object.assign(surface.style, {
		position: 'fixed',
		inset: 'auto',
		margin: '0',
		visibility: 'hidden'
	});
	// Measure outside clipping ancestors while invisible.
	const nativePopover = typeof surface.showPopover === 'function';
	const fallback = nativePopover ? undefined : fallbackLayer(surface);
	if (nativePopover) surface.showPopover();

	function anchorUnavailable() {
		return (
			context &&
			(!context.isConnected || !context.getClientRects().length || context.matches(':disabled'))
		);
	}

	async function update() {
		if (disposed) return;
		countOverlayWork('floatingUpdates');
		const token = ++revision;
		if (anchorUnavailable()) {
			close('anchor-removal');
			return;
		}
		if (stylesChanged) {
			stylesChanged = false;
			fallback?.sync();
		}
		const viewport = { padding: 8, boundary: [] };
		const result = await computePosition(anchor, surface, {
			strategy: 'fixed',
			placement: options.placement,
			middleware: [
				offset(options.gap),
				flip(viewport),
				shift(viewport),
				size({
					...viewport,
					apply({ availableWidth, availableHeight, rects }) {
						if (disposed || token !== revision) return;
						surface.style.maxWidth = `${Math.max(0, Math.min(availableWidth, options.maxWidth ?? Infinity))}px`;
						surface.style.maxHeight = `${Math.max(0, availableHeight)}px`;
						surface.style.width = options.matchWidth
							? `${Math.min(rects.reference.width, availableWidth)}px`
							: 'max-content';
					}
				}),
				...(options.referenceClipping !== 'ignore' ? [hide({ strategy: 'referenceHidden' })] : [])
			]
		});
		if (disposed || token !== revision) return;
		if (result.middlewareData.hide?.referenceHidden) {
			surface.style.visibility = 'hidden';
			if (options.referenceClipping === 'close') close('anchor-removal');
			return;
		}
		Object.assign(surface.style, {
			left: `${result.x}px`,
			top: `${result.y}px`,
			visibility: 'visible'
		});
		if (!ready) {
			ready = true;
			options.onReady?.();
		}
	}

	function scheduleUpdate() {
		if (disposed || frame !== undefined) return;
		// Discard an in-flight position as soon as its reference changes.
		revision++;
		frame = requestAnimationFrame(() => {
			frame = undefined;
			void update();
		});
	}
	const release = autoUpdate(anchor, surface, scheduleUpdate, {
		animationFrame: false,
		// A selection reference moves through its subscription, not its document-sized context.
		layoutShift: anchor instanceof HTMLElement
	});
	const releaseAnchor =
		anchor instanceof HTMLElement ? undefined : anchor.subscribe?.(scheduleUpdate);
	const releaseRemoval = context
		? watchAnchor(context, () => {
				if (disposed) return;
				if (!context.isConnected || context.matches(':disabled')) {
					revision++;
					close('anchor-removal');
				} else {
					// Blocking must apply immediately; computed styles can wait for the position frame.
					fallback?.syncBlocking();
					stylesChanged = true;
					scheduleUpdate();
				}
			})
		: undefined;
	return () => {
		disposed = true;
		revision++;
		if (frame !== undefined) cancelAnimationFrame(frame);
		release();
		releaseAnchor?.();
		releaseRemoval?.();
		if (nativePopover && surface.matches(':popover-open')) surface.hidePopover();
		fallback?.close();
	};
}
