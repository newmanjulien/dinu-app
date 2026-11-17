import { getContext, setContext } from 'svelte';
import type { SaveNotice } from '$lib/contract/editors.svelte';
import type { RenderFailure } from '$lib/document/runtime/types';
import type { OperationStatus } from './operation-status';

export type DocumentFeedback = {
	readonly feedback: OperationStatus | null;
	readonly renderError: RenderFailure | null;
	readonly sourceStale: boolean;
	readonly onRetryRender?: () => void;
};

/** Membership-owned presentation only; controllers retain all save/recovery behavior. */
export class WorkspaceFeedback {
	document = $state.raw<DocumentFeedback | null>(null);
	private alive = true;
	private live = $derived.by(() => this.liveNotices());
	notices = $derived(this.live);
	attention = $derived(
		this.live.filter(
			(notice) => ['Save failed', 'Conflict', 'Paused'].includes(notice.status) || notice.memoryOnly
		)
	);
	label = $derived(
		this.attention.length
			? `${this.attention.length} ${this.attention.length === 1 ? 'contract needs' : 'contracts need'} attention`
			: null
	);

	constructor(private liveNotices: () => readonly SaveNotice[]) {}

	statusFor(id: string) {
		const status = this.live.find((notice) => notice.id === id)?.status;
		return status === 'Save failed' || status === 'Conflict' || status === 'Paused'
			? status
			: undefined;
	}
	registerDocument(document: DocumentFeedback) {
		if (this.alive) this.document = document;
		return () => {
			if (this.document === document) this.document = null;
		};
	}
	destroy() {
		this.alive = false;
		this.document = null;
	}
}

const key = Symbol('workspace-feedback');
export const setWorkspaceFeedback = (feedback: WorkspaceFeedback) => setContext(key, feedback);
export const getWorkspaceFeedback = () => getContext<WorkspaceFeedback>(key);
