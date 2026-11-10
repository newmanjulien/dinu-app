import { getContext, setContext } from 'svelte';
import type { SnapshotClient } from '$lib/query-once';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import { queryOnce } from '$lib/query-once';
import { ReadAttempt } from '$lib/auth/attempt';
import { afterPaint, DocumentScheduler, type Priority } from '$lib/document/runtime/scheduler';
import type { PresentationOutcome } from '$lib/auth/workspace-presentation.svelte';
import { recordColdStart } from '$lib/document/runtime/render-perf';
import { BuyerDownload } from './download.svelte';

type Content = FunctionReturnType<typeof api.buyerLinks.content>;
type Host = typeof import('./BuyerDocumentHost.svelte').default;
type FailureStage =
	'content' | 'code' | 'construction' | 'source' | 'preparation' | 'page-mount' | 'opening';
const key = Symbol('buyer-contract');

/** One anonymous token, one immutable contract snapshot, and one preparation generation. */
export class BuyerContract {
	content = $state.raw<Content>();
	displayed = $state.raw<Content>();
	private displayOwner?: symbol;
	bindDisplay(generation: number, content: Content) {
		if (
			generation !== this.generation ||
			!this.allowed ||
			!this.foreground ||
			content !== this.content
		)
			return () => {};
		const owner = (this.displayOwner = Symbol('displayed-publication'));
		this.displayed = content;
		return () => {
			if (this.displayOwner === owner) {
				this.displayed = undefined;
				this.displayOwner = undefined;
			}
		};
	}
	Host = $state.raw<Host>();
	target = $state.raw<HTMLElement>();
	allowed = $state(false);
	connected = $state(false);
	mountReady = $state(false);
	error = $state<string | null>(null);
	publicationError = $state<string | null>(null);
	generation = $state(0);
	scheduler = $state.raw(this.createScheduler());
	readonly priority: Priority = () => 'foreground';
	readonly download: BuyerDownload;
	private stopPublication?: () => void;
	private templateItems: Content['items'] = [];
	private toolsOwner = $state.raw<symbol>();
	private lifetime?: AbortController;
	private opening?: ReadAttempt;
	private presentation: PresentationOutcome = 'pending';
	private presentationRevision = 0;
	private openedAt = 0;
	private failureStage?: FailureStage;

	constructor(
		readonly token: string,
		private client: SnapshotClient
	) {
		this.download = new BuyerDownload(token, this);
	}
	get hasTools() {
		return this.toolsOwner !== undefined;
	}
	registerTools() {
		const owner = Symbol('buyer-tools');
		this.toolsOwner = owner;
		return () => {
			if (this.toolsOwner === owner) this.toolsOwner = undefined;
		};
	}
	get foreground() {
		return Boolean(this.target);
	}
	private createScheduler() {
		return new DocumentScheduler();
	}
	setAccess(allowed: boolean) {
		if (this.allowed === allowed) return;
		this.allowed = allowed;
		if (!allowed) {
			this.release();
			this.content = undefined;
			this.templateItems = [];
			this.Host = undefined;
			this.error = null;
		} else if (this.foreground) this.start();
	}
	attach(target: HTMLElement) {
		this.target = target;
		this.scheduler.wake();
		if (this.allowed && !this.error) {
			this.beginOpening();
			this.start();
			this.present(this.generation, this.presentation);
		}
		return () => {
			if (this.target !== target) return;
			this.target = undefined;
			this.stopPublication?.();
			this.stopPublication = undefined;
			this.download.reset();
			this.displayed = undefined;
			this.opening?.abort();
			this.opening = undefined;
			this.scheduler.wake();
		};
	}
	private beginOpening() {
		const previous = this.opening;
		this.opening = undefined;
		previous?.abort();
		this.openedAt = performance.now();
		recordColdStart('buyer-contract-open');
		const attempt = (this.opening = new ReadAttempt(15_000));
		attempt.signal.addEventListener(
			'abort',
			() => {
				if (this.opening === attempt && this.foreground) this.fail(this.generation, 'opening');
			},
			{ once: true }
		);
	}
	private start() {
		if (this.content && this.foreground) this.subscribePublication();
		if (!this.allowed || this.error || this.lifetime) return;
		const lifetime = (this.lifetime = new AbortController());
		const generation = this.generation;
		const startedAt = performance.now();
		if (this.foreground && !this.opening) this.beginOpening();
		if (!this.content) recordColdStart('buyer-content-start');
		if (!this.Host) recordColdStart('buyer-viewer-code-start');
		const content = this.content
			? Promise.resolve(this.content)
			: queryOnce(this.client, api.buyerLinks.content, { token: this.token }, lifetime.signal)
					.then((value) => {
						if (this.isCurrent(generation, lifetime)) {
							this.templateItems = value.templateItems;
							const merged = new Map(this.templateItems.map((item) => [item.itemId, item]));
							for (const item of value.items) merged.set(item.itemId, item);
							this.content = { ...value, items: [...merged.values()] };
							this.subscribePublication();
							recordColdStart('buyer-content-ready', startedAt);
						}
					})
					.catch(() => {
						if (this.isCurrent(generation, lifetime)) this.fail(generation, 'content');
					});
		const code = this.Host
			? Promise.resolve(this.Host)
			: import('./BuyerDocumentHost.svelte')
					.then((module) => {
						if (this.isCurrent(generation, lifetime)) {
							this.Host = module.default;
							recordColdStart('buyer-viewer-code-ready', startedAt);
						}
					})
					.catch(() => {
						if (this.isCurrent(generation, lifetime)) this.fail(generation, 'code');
					});
		void Promise.all([content, code])
			.then(async () => {
				if (!this.isCurrent(generation, lifetime) || this.error) return;
				// Admit synchronous workspace/subtree construction under the same policy as later slices.
				await this.scheduler.run(
					this.priority,
					() => {
						if (this.isCurrent(generation, lifetime) && !this.error) {
							this.mountReady = true;
							recordColdStart('buyer-workspace-admitted', startedAt);
						}
					},
					lifetime.signal
				);
			})
			.catch(() => {
				if (this.isCurrent(generation, lifetime)) this.fail(generation, 'construction');
			});
	}
	private subscribePublication() {
		if (this.stopPublication || !this.allowed || !this.foreground || !this.content) return;
		this.stopPublication = this.client.onUpdate(
			api.buyerLinks.publication,
			{ token: this.token },
			(publication) => {
				if (
					!this.allowed ||
					!this.foreground ||
					!this.content ||
					publication.buyerRevision < this.content.buyerRevision
				)
					return;
				this.publicationError = null;
				if (publication.buyerRevision === this.content.buyerRevision) return;
				const items = new Map(this.templateItems.map((item) => [item.itemId, item]));
				for (const item of publication.items) items.set(item.itemId, item);
				this.content = { ...this.content, ...publication, items: [...items.values()] };
			},
			() => {
				if (this.allowed && this.foreground)
					this.publicationError = 'We couldn’t refresh this contract. Your draft is still here.';
			}
		);
	}
	retryPublication() {
		this.stopPublication?.();
		this.stopPublication = undefined;
		this.publicationError = null;
		this.subscribePublication();
	}
	private isCurrent(generation: number, lifetime: AbortController) {
		return (
			this.allowed &&
			generation === this.generation &&
			this.lifetime === lifetime &&
			!lifetime.signal.aborted
		);
	}
	present(generation: number, outcome: PresentationOutcome) {
		if (generation !== this.generation || !this.allowed || this.error) return;
		const revision = ++this.presentationRevision;
		this.presentation = outcome;
		// A completed attempt has no timer. Font invalidation needs a new bounded attempt,
		// even if another success notification is still waiting for its paint opportunity.
		if (outcome === 'pending' && !this.opening && this.foreground) this.beginOpening();
		if (outcome === 'error') return this.fail(generation, 'preparation');
		if (outcome !== 'success') return;
		const attempt = this.opening;
		const target = this.target;
		if (!attempt || !target) return;
		void afterPaint(attempt.signal)
			.then(() => {
				if (
					this.opening !== attempt ||
					this.presentationRevision !== revision ||
					this.target !== target ||
					!target.isConnected ||
					this.presentation !== 'success' ||
					this.error ||
					!this.allowed ||
					this.generation !== generation
				)
					return;
				this.opening = undefined;
				recordColdStart('buyer-contract-visible', this.openedAt);
				attempt.complete();
			})
			.catch(() => {}); // Only this attempt's owned paint cancellation rejects.
	}
	fail(generation: number, stage: FailureStage) {
		if (!this.allowed || generation !== this.generation || this.error) return;
		this.failureStage = stage;
		// Never log the bearer token, document, or raw backend/render exception.
		console.error('Buyer contract failed', { stage });
		this.error =
			stage === 'opening'
				? 'This contract is taking longer than expected to display. Try again.'
				: 'We couldn’t display this contract. Try again.';
		const opening = this.opening;
		this.opening = undefined;
		opening?.abort();
		this.lifetime?.abort();
	}
	retry() {
		if (!this.allowed) return;
		const compatible =
			this.mountReady && this.content && this.Host && this.failureStage === 'opening';
		if (compatible) {
			this.lifetime?.abort();
			this.lifetime = undefined;
		} else this.release();
		this.error = null;
		this.failureStage = undefined;
		this.start();
		if (compatible) this.present(this.generation, this.presentation);
	}
	private release() {
		this.stopPublication?.();
		this.stopPublication = undefined;
		this.download.reset();
		this.displayed = undefined;
		// Clear identity before aborting, so obsolete callbacks cannot fail the next generation.
		this.generation++;
		const opening = this.opening;
		this.opening = undefined;
		opening?.abort();
		this.lifetime?.abort();
		this.lifetime = undefined;
		this.mountReady = false;
		this.presentation = 'pending';
		this.scheduler.destroy();
		this.scheduler = this.createScheduler();
	}
	destroy() {
		this.allowed = false;
		this.release();
		this.download.destroy();
		this.toolsOwner = undefined;
		this.scheduler.destroy();
		this.content = undefined;
		this.templateItems = [];
		this.Host = undefined;
		this.target = undefined;
	}
}

export const setBuyerContract = (contract: BuyerContract) => setContext(key, contract);
export const getBuyerContract = () => getContext<BuyerContract>(key);
