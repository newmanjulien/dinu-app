import { getContext, setContext, tick } from 'svelte';
import { page } from '$app/state';
import { initialAvailability, useCsmPreload, type CsmOwner } from './csm-preload.svelte';
import { supportContent, type SupportContent, type SupportContext } from './csm-support';
import type { AvailabilitySelection } from './csm-availability';
import type { CsmBookingMode, CsmReplacement } from './csm-booking';

export type CsmRequest = {
	path: string;
	owner: CsmOwner;
	initial: AvailabilitySelection;
	context: SupportContext;
	content: SupportContent;
	trigger?: HTMLButtonElement;
	onBooked?: () => void;
};
const key = Symbol('csm-dialog');
export function setCsmDialog(canStart: () => boolean, support: () => SupportContext | undefined) {
	const preload = useCsmPreload();
	let request = $state.raw<CsmRequest>();
	let fallback: (() => void) | undefined;
	function content() {
		const context = support();
		return request && current(request)
			? request.content
			: context
				? supportContent(context)
				: undefined;
	}
	function current(value: CsmRequest) {
		const context = support();
		return (
			request === value &&
			preload.owner === value.owner &&
			value.owner.availability.current() &&
			value.path === page.url.pathname &&
			context?.section === value.context.section
		);
	}
	function open(
		mode: CsmBookingMode,
		trigger?: HTMLButtonElement,
		onBooked?: () => void,
		replacement?: CsmReplacement
	) {
		const context = support();
		if (request || !context) return false;
		const owner = preload.align();
		if (!owner?.canRead(mode, replacement)) return false;
		// Target identity is frozen synchronously, before any import/read can finish.
		const initial = {
			...initialAvailability(mode),
			...(replacement ? { replacement: { ...replacement } } : {})
		};
		request = {
			path: page.url.pathname,
			owner,
			initial,
			context,
			content: supportContent(context),
			trigger,
			onBooked
		};
		return true;
	}
	const value = {
		get request() {
			return request;
		},
		get content() {
			return content();
		},
		canStart,
		current,
		openSupport: (trigger?: HTMLButtonElement, onBooked?: () => void) =>
			open('support', trigger, onBooked),
		replace: (target: CsmReplacement, trigger: HTMLButtonElement) =>
			open('setup', trigger, undefined, target),
		align() {
			if (request && !current(request)) request = undefined;
		},
		booked(value: CsmRequest) {
			if (!current(value)) return;
			value.onBooked?.();
		},
		async close(value: CsmRequest) {
			if (request !== value) return;
			request = undefined;
			await tick();
			if (request) return;
			if (
				value.trigger?.isConnected &&
				!value.trigger.disabled &&
				value.trigger.getClientRects().length
			)
				value.trigger.focus({ preventScroll: true });
			else fallback?.();
		},
		setFocusFallback(restore: () => void) {
			fallback = restore;
			return () => {
				if (fallback === restore) fallback = undefined;
			};
		}
	};
	return setContext(key, value);
}
export const useCsmDialog = () => getContext<ReturnType<typeof setCsmDialog>>(key);
