/** A readable portion of text must remain visible for 500ms in the focused tab. */
export function observeVisibleMessage(
	element: HTMLElement,
	current: () => boolean,
	acknowledge: (stillVisible: () => boolean) => Promise<boolean>
) {
	let intersecting = false;
	let stopped = false;
	let busy = false;
	let since: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	function readable() {
		if (
			stopped ||
			!intersecting ||
			!element.isConnected ||
			!current() ||
			document.visibilityState !== 'visible' ||
			!document.hasFocus() ||
			!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
		)
			return false;
		const rect = element.getBoundingClientRect();
		let left = Math.max(0, rect.left),
			right = Math.min(window.innerWidth, rect.right);
		let top = Math.max(0, rect.top),
			bottom = Math.min(window.innerHeight, rect.bottom);
		for (let parent = element.parentElement; parent; parent = parent.parentElement) {
			const style = getComputedStyle(parent);
			const clipsX = /^(auto|scroll|hidden|clip)$/u.test(style.overflowX);
			const clipsY = /^(auto|scroll|hidden|clip)$/u.test(style.overflowY);
			if (!clipsX && !clipsY) continue;
			const bounds = parent.getBoundingClientRect();
			if (clipsX) {
				left = Math.max(left, bounds.left + parent.clientLeft);
				right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth);
			}
			if (clipsY) {
				top = Math.max(top, bounds.top + parent.clientTop);
				bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
			}
		}
		if (right <= left || bottom <= top) return false;
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const range = document.createRange();
		// Measure wording, not blank lines or unused paragraph width, in the current layout.
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			for (const word of (node.textContent ?? '').matchAll(/\S+/gu)) {
				range.setStart(node, word.index);
				range.setEnd(node, word.index + word[0].length);
				for (const fragment of range.getClientRects()) {
					if (!fragment.width || !fragment.height) continue;
					const visibleLeft = Math.max(left, fragment.left),
						visibleRight = Math.min(right, fragment.right),
						visibleTop = Math.max(top, fragment.top),
						visibleBottom = Math.min(bottom, fragment.bottom);
					if (
						visibleRight - visibleLeft < Math.min(48, fragment.width) ||
						visibleBottom - visibleTop < Math.min(16, fragment.height)
					)
						continue;
					const x = (visibleLeft + visibleRight) / 2;
					const inset = Math.min(8, (visibleBottom - visibleTop) / 4);
					if (
						[visibleTop + inset, (visibleTop + visibleBottom) / 2, visibleBottom - inset].some(
							(y) => element.contains(document.elementFromPoint(x, y))
						)
					)
						return true;
				}
			}
		}
		return false;
	}
	function check() {
		clearTimeout(timer);
		timer = undefined;
		if (stopped || busy) return;
		if (!readable()) since = undefined;
		else {
			since ??= performance.now();
			if (performance.now() - since >= 500) {
				busy = true;
				void acknowledge(readable).then((seen) => {
					busy = false;
					if (seen) stop();
					else if (!stopped) {
						since = undefined;
						timer = setTimeout(check, 5000);
					}
				});
				return;
			}
		}
		if (intersecting && document.visibilityState === 'visible' && document.hasFocus())
			timer = setTimeout(check, 100);
	}
	const observer = new IntersectionObserver(([entry]) => {
		intersecting = entry.isIntersecting;
		check();
	});
	function reset() {
		since = undefined;
		check();
	}
	function stop() {
		stopped = true;
		clearTimeout(timer);
		observer.disconnect();
		window.removeEventListener('focus', reset);
		window.removeEventListener('blur', reset);
		document.removeEventListener('visibilitychange', reset);
	}
	observer.observe(element);
	window.addEventListener('focus', reset);
	window.addEventListener('blur', reset);
	document.addEventListener('visibilitychange', reset);
	return stop;
}
