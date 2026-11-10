import { buildClerkJSScriptAttributes, clerkJSScriptUrl } from '@clerk/shared/loadClerkJsScript';
import type { ClerkContext } from 'svelte-clerk';

const scriptOptions = (publishableKey: string) => ({
	publishableKey,
	__internal_clerkJSVersion: '6.38.0'
});

const escapeAttribute = (value: string) =>
	value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Native handlers retain completion even when the script finishes before hydration. */
export function clerkScriptHead(publishableKey: string) {
	const url = clerkJSScriptUrl(scriptOptions(publishableKey));
	const attributes = Object.entries(buildClerkJSScriptAttributes({ publishableKey }))
		.map(([key, value]) => `${key}="${escapeAttribute(value)}"`)
		.join(' ');
	return `<link rel="preconnect" href="${escapeAttribute(new URL(url).origin)}" crossorigin="anonymous"><script async crossorigin="anonymous" data-clerk-js-script ${attributes} src="${escapeAttribute(url)}" onload="this.dataset.loadState='loaded'" onerror="this.dataset.loadState='error'"></script>`;
}

/** One event-driven wait; the provider owns its lifetime and deadline. */
export function waitForClerkScript(publishableKey: string, signal: AbortSignal) {
	if (window.Clerk) return Promise.resolve(window.Clerk);
	document.querySelector('script[data-clerk-js-script][data-load-state="error"]')?.remove();
	return new Promise<NonNullable<ClerkContext['clerk']>>((resolve, reject) => {
		let script = document.querySelector<HTMLScriptElement>('script[data-clerk-js-script]');
		const created = !script;
		script ??= document.createElement('script');
		const element = script;
		const cleanup = () => {
			element.removeEventListener('load', loaded);
			element.removeEventListener('error', failed);
			signal.removeEventListener('abort', aborted);
		};
		const failed = () => {
			element.dataset.loadState = 'error';
			cleanup();
			reject(new Error('Sign-in could not connect. Please try again.'));
		};
		const loaded = () => {
			cleanup();
			if (window.Clerk) resolve(window.Clerk);
			else failed();
		};
		const aborted = () => {
			cleanup();
			element.remove();
			reject(signal.reason);
		};
		if (signal.aborted) return aborted();
		element.addEventListener('load', loaded, { once: true });
		element.addEventListener('error', failed, { once: true });
		signal.addEventListener('abort', aborted, { once: true });
		if (element.dataset.loadState === 'error') failed();
		else if (window.Clerk || element.dataset.loadState === 'loaded') loaded();
		else if (created) {
			element.async = true;
			element.crossOrigin = 'anonymous';
			element.dataset.clerkJsScript = '';
			for (const [key, value] of Object.entries(buildClerkJSScriptAttributes({ publishableKey })))
				element.setAttribute(key, value);
			element.src = clerkJSScriptUrl(scriptOptions(publishableKey));
			document.head.append(element);
		}
	});
}
