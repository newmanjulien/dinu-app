import { vi } from 'vitest';
import { frameClock } from './snappiness-fixtures';

/** Controlled observer/rectangle delivery, not a browser layout or frame-rate simulation. */
export function documentDom() {
	const clock = frameClock();
	let visiblePage = 1;
	const restore: (() => void)[] = [];
	function property(target: object, key: string, value: unknown) {
		const descriptor = Object.getOwnPropertyDescriptor(target, key);
		Object.defineProperty(target, key, { configurable: true, value });
		restore.push(() => {
			if (descriptor) Object.defineProperty(target, key, descriptor);
			else Reflect.deleteProperty(target, key);
		});
	}
	const fonts = Object.assign(new EventTarget(), { status: 'loaded', ready: Promise.resolve() });
	property(document, 'fonts', fonts);
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		}
	);
	const intersections: { callback: IntersectionObserverCallback; targets: Set<Element> }[] = [];
	vi.stubGlobal(
		'IntersectionObserver',
		class {
			targets = new Set<Element>();
			constructor(callback: IntersectionObserverCallback) {
				intersections.push({ callback, targets: this.targets });
			}
			observe(target: Element) {
				this.targets.add(target);
			}
			unobserve(target: Element) {
				this.targets.delete(target);
			}
			disconnect() {
				this.targets.clear();
			}
		}
	);
	vi.stubGlobal('matchMedia', () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {}
	}));
	vi.stubGlobal('CSS', {
		escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
		supports: () => false
	});
	property(window, 'innerHeight', 800);
	property(window, 'innerWidth', 1200);
	property(HTMLElement.prototype, 'offsetWidth', 600);
	const rect = (element: Element | null) => {
		const page = element?.closest<HTMLElement>('.document-page');
		const top = page ? 80 + (Number(page.dataset.pageNumber) - visiblePage) * 1000 : 80;
		return new DOMRect(20, top, 600, element?.matches('.document-page') ? 700 : 20);
	};
	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
		return rect(this);
	});
	property(
		Range.prototype,
		'getClientRects',
		vi.fn(function (this: Range) {
			const element =
				this.startContainer instanceof Element
					? this.startContainer
					: this.startContainer.parentElement;
			const bounds = rect(element);
			return [
				new DOMRect(
					bounds.left + this.startOffset * 5,
					bounds.top,
					Math.max(1, (this.endOffset - this.startOffset) * 5),
					20
				)
			];
		})
	);
	property(Range.prototype, 'getBoundingClientRect', function (this: Range) {
		return this.getClientRects()[0] ?? new DOMRect();
	});
	property(document, 'elementFromPoint', () =>
		document.querySelector(`.document-page[data-page-number="${visiblePage}"] p span`)
	);
	property(window, 'scrollBy', vi.fn());
	property(Element.prototype, 'scrollIntoView', vi.fn());
	return {
		...clock,
		showPage(number: number) {
			visiblePage = number;
			for (const observer of intersections) {
				const entries = [...observer.targets].map(
					(target) =>
						({
							target,
							isIntersecting: Number((target as HTMLElement).dataset.pageNumber) === number,
							intersectionRect: {
								height: Number((target as HTMLElement).dataset.pageNumber) === number ? 700 : 0
							}
						}) as IntersectionObserverEntry
				);
				observer.callback(entries, {} as IntersectionObserver);
			}
		},
		destroy() {
			for (const cleanup of restore.reverse()) cleanup();
		}
	};
}
