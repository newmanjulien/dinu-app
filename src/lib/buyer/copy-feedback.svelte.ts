import { getContext, setContext } from 'svelte';

type CopyNotice = { message: string; kind: 'success' | 'error' };

/** Workspace-owned so closing a menu or removing a card cannot remove its feedback. */
export class BuyerLinkCopyFeedback {
	notice = $state.raw<CopyNotice | null>(null);
	private timer: ReturnType<typeof setTimeout> | undefined;
	private alive = true;

	show = (created: boolean) => {
		this.publish(
			{ message: created ? 'Link created and copied' : 'Link copied', kind: 'success' },
			2500
		);
	};

	showError = (message: string) => {
		this.publish({ message, kind: 'error' }, 5000);
	};

	private publish(notice: CopyNotice, durationMs: number) {
		if (!this.alive) return;
		clearTimeout(this.timer);
		this.notice = notice;
		this.timer = setTimeout(() => (this.notice = null), durationMs);
	}

	destroy() {
		this.alive = false;
		clearTimeout(this.timer);
		this.notice = null;
	}
}

const key = Symbol('buyer-link-copy-feedback');
export const setBuyerLinkCopyFeedback = () => setContext(key, new BuyerLinkCopyFeedback());
export const getBuyerLinkCopyFeedback = () => getContext<BuyerLinkCopyFeedback>(key);
