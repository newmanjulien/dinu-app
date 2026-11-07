import { getContext, setContext, tick } from 'svelte';
import { page } from '$app/state';
import { initialCalendar, useCsmPreload, type CsmOwner } from './csm-preload.svelte';
import { loadCsmModal } from './csm-modal';
import type { CalendarSelection } from './csm-availability';
import type { CsmBookingMode, CsmReplacement } from './csm-booking';

export type CsmRequest = {
	path: string;
	owner: CsmOwner;
	initial: CalendarSelection;
	trigger?: HTMLButtonElement;
	onOpen?: () => void;
	onBooked?: () => void;
};
const key = Symbol('csm-dialog');
export function setCsmDialog(
	canStart: () => boolean,
	setupAvailable: () => boolean,
	onSetupBooked: () => void
) {
	const preload = useCsmPreload();
	let request = $state.raw<CsmRequest>();
	let fallback: (() => void) | undefined;
	function current(value: CsmRequest) {
		return (
			request === value &&
			preload.owner === value.owner &&
			value.owner.calendar.current() &&
			value.path === page.url.pathname &&
			(!!value.initial.replacement || value.initial.mode !== 'setup' || setupAvailable())
		);
	}
	function open(
		mode: CsmBookingMode,
		trigger?: HTMLButtonElement,
		callbacks?: Pick<CsmRequest, 'onOpen' | 'onBooked'>,
		replacement?: CsmReplacement
	) {
		if (request) return false;
		const owner = preload.align();
		if (!owner?.canRead(mode, replacement)) return false;
		// Target identity is frozen synchronously, before any import/read can finish.
		const initial = {
			...initialCalendar(mode),
			...(replacement ? { replacement: { ...replacement } } : {})
		};
		void loadCsmModal().catch(() => {});
		request = { path: page.url.pathname, owner, initial, trigger, ...callbacks };
		return true;
	}
	const value = {
		get request() {
			return request;
		},
		canStart,
		current,
		open,
		replace: (target: CsmReplacement, trigger: HTMLButtonElement) =>
			open('setup', trigger, undefined, target),
		align() {
			if (request && !current(request)) request = undefined;
		},
		booked(value: CsmRequest) {
			if (!current(value)) return;
			if (value.initial.mode === 'setup') onSetupBooked();
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
