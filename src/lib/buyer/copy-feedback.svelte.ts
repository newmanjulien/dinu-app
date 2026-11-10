import { getContext, setContext } from 'svelte';

/** Workspace-owned so closing a menu or removing a card cannot remove its confirmation. */
export class BuyerLinkCopyFeedback {
	confirmation = $state.raw<{ message: string } | null>(null);
	private timer: ReturnType<typeof setTimeout> | undefined;
	private alive = true;

	show = () => {
		if (!this.alive) return;
		clearTimeout(this.timer);
		this.confirmation = { message: 'Latest link copied' };
		this.timer = setTimeout(() => (this.confirmation = null), 2500);
	};

	destroy() {
		this.alive = false;
		clearTimeout(this.timer);
		this.confirmation = null;
	}
}

const key = Symbol('buyer-link-copy-feedback');
export const setBuyerLinkCopyFeedback = () => setContext(key, new BuyerLinkCopyFeedback());
export const getBuyerLinkCopyFeedback = () => getContext<BuyerLinkCopyFeedback>(key);
