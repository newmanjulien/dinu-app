import { getContext, setContext } from 'svelte';
import type { SaveNotice } from '$lib/contract/editors.svelte';
import type { RenderFailure } from '$lib/document/runtime/types';
import type { OperationStatus } from './operation-status';

type Completion = { acknowledgedAt: number; expires: number; sequence: number };
type AuthoringCompletion = { readonly kind: 'saved' | 'deleted' };
export type DocumentFeedback = {
	readonly feedback: OperationStatus | null;
	readonly renderPending: boolean;
	readonly renderError: RenderFailure | null;
	readonly sourceStale: boolean;
	readonly onRetryRender?: () => void;
};

/** Membership-owned presentation only; controllers retain all save/recovery behavior. */
export class WorkspaceFeedback {
	private recent = $state.raw<readonly (SaveNotice & Completion)[]>([]);
	private authoringCompletion = $state.raw<
		(Completion & { owner: symbol; kind: AuthoringCompletion['kind'] }) | null
	>(null);
	private authoring = $state.raw<{ owner: symbol; blocked: boolean } | null>(null);
	document = $state.raw<DocumentFeedback | null>(null);
	private sequence = 0;
	private expiryTimer: ReturnType<typeof setTimeout> | undefined;
	private alive = true;
	private releaseEffects: () => void;
	private showProgress = $state(false);
	private live = $derived.by(() => this.liveNotices());
	private busy = $derived(
		this.live.some((notice) => notice.status === 'Saving' || notice.status === 'Checking')
	);
	attention = $derived(
		this.live.filter(
			(notice) => ['Save failed', 'Conflict', 'Paused'].includes(notice.status) || notice.memoryOnly
		)
	);
	notices = $derived.by((): readonly SaveNotice[] => {
		const liveIds = new Set(this.live.map((notice) => notice.id));
		return [...this.live, ...this.recent.filter((notice) => !liveIds.has(notice.id))];
	});
	private noticesById = $derived(new Map(this.notices.map((notice) => [notice.id, notice])));
	private completion = $derived.by(() => {
		const latest = this.recent.reduce<(Completion & { kind: 'saved' | 'deleted' }) | null>(
			(previous, notice) =>
				!previous || notice.sequence > previous.sequence ? { ...notice, kind: 'saved' } : previous,
			this.authoringCompletion
		);
		return latest?.kind === 'deleted' ? 'Box deleted.' : latest ? 'Changes saved' : null;
	});
	label = $derived(
		this.attention.length
			? `${this.attention.length} ${this.attention.length === 1 ? 'contract needs' : 'contracts need'} attention`
			: this.busy
				? this.showProgress
					? this.live.some((notice) => notice.status === 'Checking')
						? 'Checking changes…'
						: 'Saving changes…'
					: null
				: this.authoring?.blocked
					? null
					: this.completion
	);

	constructor(private liveNotices: () => readonly SaveNotice[]) {
		this.releaseEffects = $effect.root(() => {
			// Depend on continuous activity, not individual notice updates during a burst.
			$effect(() => {
				this.showProgress = false;
				if (!this.busy) return;
				const timer = setTimeout(() => (this.showProgress = true), 250);
				return () => clearTimeout(timer);
			});
		});
	}
	statusFor(id: string) {
		return this.noticesById.get(id)?.status;
	}
	private stamp(): Completion {
		const acknowledgedAt = Date.now();
		return { acknowledgedAt, expires: acknowledgedAt + 2500, sequence: ++this.sequence };
	}
	contractSaved = (notice: SaveNotice) => {
		if (!this.alive) return;
		this.recent = [
			...this.recent.filter((recent) => recent.id !== notice.id),
			{ ...notice, ...this.stamp() }
		].slice(-20);
		this.expire();
	};
	contractDeleted = (id: string) => {
		if (!this.alive) return;
		this.recent = this.recent.filter((notice) => notice.id !== id);
		this.expire();
	};
	contractRenamed = (id: string, name: string) => {
		if (!this.alive) return;
		this.recent = this.recent.map((notice) => (notice.id === id ? { ...notice, name } : notice));
	};
	private expire() {
		clearTimeout(this.expiryTimer);
		const now = Date.now();
		this.recent = this.recent.filter((notice) => notice.expires > now);
		if (this.authoringCompletion && this.authoringCompletion.expires <= now)
			this.authoringCompletion = null;
		const expiries = this.recent.map((notice) => notice.expires);
		if (this.authoringCompletion) expiries.push(this.authoringCompletion.expires);
		if (expiries.length)
			this.expiryTimer = setTimeout(() => this.expire(), Math.max(1, Math.min(...expiries) - now));
	}
	registerDocument(document: DocumentFeedback) {
		if (this.alive) this.document = document;
		return () => {
			if (this.document === document) this.document = null;
		};
	}
	registerAuthoring() {
		const owner = Symbol('authoring-feedback');
		if (this.alive) this.authoring = { owner, blocked: false };
		let previous: AuthoringCompletion | null = null;
		return {
			update: (completion: AuthoringCompletion | null, blocked: boolean) => {
				if (!this.alive || this.authoring?.owner !== owner) return;
				if (this.authoring.blocked !== blocked) this.authoring = { owner, blocked };
				if (completion === previous) return;
				previous = completion;
				if (completion)
					this.authoringCompletion = { ...this.stamp(), owner, kind: completion.kind };
				else if (this.authoringCompletion?.owner === owner) this.authoringCompletion = null;
				this.expire();
			},
			release: () => {
				if (this.authoring?.owner === owner) this.authoring = null;
			}
		};
	}
	destroy() {
		this.alive = false;
		clearTimeout(this.expiryTimer);
		this.releaseEffects();
		this.document = null;
		this.authoring = null;
		this.authoringCompletion = null;
		this.recent = [];
	}
}

const key = Symbol('workspace-feedback');
export const setWorkspaceFeedback = (feedback: WorkspaceFeedback) => setContext(key, feedback);
export const getWorkspaceFeedback = () => getContext<WorkspaceFeedback>(key);
