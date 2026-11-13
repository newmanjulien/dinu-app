import { subscribeNativePage, type NativePageSubscription } from '../native-pagination';
import { untrack } from 'svelte';
import type { ConvexClient } from 'convex/browser';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { ReadAttempt, waitForRead } from '../auth/attempt';
import { saveError } from './saved';
import type { ChangeKind, ChangeReview } from './changes';

type Options = {
	client: Pick<ConvexClient, 'action' | 'onPaginatedUpdate_experimental'>;
	membershipId: Id<'memberships'>;
	id: Id<'savedContracts'>;
	kind?: ChangeKind;
	documentId: () => Id<'contractDocuments'>;
	enabled: () => boolean;
	generation: () => unknown;
	autoLoad?: boolean;
};
/** The supplied transport owns native cursor/split handling and private authorization. */
export class ContractReviewPages {
	rows = $state.raw<ChangeReview[]>([]);
	loading = $state(false);
	done = $state(false);
	error = $state<string | null>(null);
	detailError = $state<string | null>(null);
	private accepted: ChangeReview[] = [];
	private details = new Map<string, ChangeReview>();
	private flights = new Map<string, ReadAttempt>();
	private failedDetails = new Set<string>();
	private detailRevision = 0;
	private revision = $state(0);
	private timedOut = $state(false);
	private destroyed = $state(false);
	private active = false;
	private scope = '';
	private documentId?: Id<'contractDocuments'>;
	private attempt?: ReadAttempt;
	private more?: () => void;
	constructor(private options: Options) {
		let nativeRows = $state.raw<ChangeReview[]>([]);
		let nativeStatus = $state<'LoadingFirstPage' | 'LoadingMore' | 'CanLoadMore' | 'Exhausted'>(
			'LoadingFirstPage'
		);
		let nativeError = $state.raw<Error>();
		$effect(() => {
			void this.revision;
			options.generation();
			options.documentId();
			if (!options.enabled() || this.destroyed || this.timedOut) return;
			untrack(() => {
				nativeRows = [];
				nativeStatus = 'LoadingFirstPage';
				nativeError = undefined;
			});
			let active = true;
			let subscription: NativePageSubscription<ChangeReview> | undefined;
			const initialRequest = { baseline: 0 };
			let pending: typeof initialRequest | undefined = initialRequest;
			let latestRequest = initialRequest;
			const update = () => {
				const value = subscription?.getCurrentValue();
				if (!active || !value) return;
				nativeRows = value.results;
				nativeStatus = value.status;
				this.more = () => {
					if (!active || pending || value.status !== 'CanLoadMore') return;
					const previous = latestRequest;
					const request = { baseline: value.results.length };
					pending = latestRequest = request;
					if (!value.loadMore(8)) {
						if (pending === request) pending = undefined;
						if (latestRequest === request) latestRequest = previous;
					}
				};
				if (value.status !== 'CanLoadMore' && value.status !== 'Exhausted') return;
				const settled = pending;
				if (!settled) return;
				pending = undefined;
				// Only a completed request can continue an empty page or seller autoload.
				if (
					value.status === 'CanLoadMore' &&
					(options.autoLoad || value.results.length <= settled.baseline)
				)
					queueMicrotask(() => {
						if (active && latestRequest === settled && !pending) this.loadMore();
					});
			};
			subscription = subscribeNativePage(
				options.client,
				api.contractApprovals.changes,
				{
					membershipId: options.membershipId,
					id: options.id,
					...(options.kind ? { kind: options.kind } : {})
				},
				8,
				update,
				(error) => {
					if (active) nativeError = error;
				}
			);
			update();
			return () => {
				active = false;
				subscription?.unsubscribe();
				this.more = undefined;
			};
		});
		$effect(() => {
			const enabled = options.enabled() && !this.destroyed;
			const scope = JSON.stringify([options.membershipId, options.generation()]);
			const documentId = options.documentId();
			const rows = nativeRows,
				status = nativeStatus,
				error = nativeError,
				timedOut = this.timedOut;
			untrack(() => {
				if (scope !== this.scope || documentId !== this.documentId || !enabled) {
					this.stopDetailReads();
					this.failedDetails.clear();
					if (scope !== this.scope || !enabled) this.details.clear();
					this.rows = [];
					this.accepted = [];
					this.scope = scope;
					this.documentId = documentId;
					this.detailError = null;
				}
				this.active = enabled;
				if (!enabled) {
					this.rows = [];
					this.accepted = [];
					this.attempt?.abort();
					this.attempt = undefined;
					return;
				}
				if (timedOut) return;
				if (error) {
					this.rows = [];
					this.error = saveError(error, 'We couldn’t load contract reviews. Try again.');
					this.loading = false;
					this.attempt?.complete();
					this.attempt = undefined;
					return;
				}
				this.error = null;
				this.loading = status === 'LoadingFirstPage' || status === 'LoadingMore';
				this.done = status === 'Exhausted';
				if (this.loading && !this.attempt) {
					const attempt = new ReadAttempt(15_000);
					this.attempt = attempt;
					attempt.signal.addEventListener(
						'abort',
						() => {
							if (!this.active || this.attempt !== attempt) return;
							this.timedOut = true;
							this.loading = false;
							this.error = 'Review request timed out. Try again.';
						},
						{ once: true }
					);
				}
				if (!this.loading) {
					this.attempt?.complete();
					this.attempt = undefined;
				}
				this.accepted = rows.filter((row) => row.previewIdentity.startsWith(`${documentId}:`));
				this.publish();
			});
		});
	}
	private key(row: ChangeReview) {
		return JSON.stringify([
			this.options.membershipId,
			this.scope,
			this.documentId,
			row.changeId,
			row.currentChangeId,
			row.appliedChangeId,
			row.decisionId,
			row.status
		]);
	}
	private cached(key: string) {
		const value = this.details.get(key);
		if (value) {
			this.details.delete(key);
			this.details.set(key, value);
		}
		return value;
	}
	private publish() {
		const previous = new Map(
			this.rows.filter((row) => !row.detailRequired).map((row) => [this.key(row), row])
		);
		const rows = [...new Map(this.accepted.map((row) => [row.changeId, row])).values()];
		this.rows = rows.map((row) => this.cached(this.key(row)) ?? previous.get(this.key(row)) ?? row);
		this.resolveDetails();
	}
	private resolveDetails() {
		if (!this.active || !this.documentId) return;
		for (const row of this.rows) {
			if (!row.detailRequired || this.flights.size >= 2) continue;
			const key = this.key(row);
			if (this.details.has(key) || this.flights.has(key) || this.failedDetails.has(key)) continue;
			const revision = this.detailRevision;
			const attempt = new ReadAttempt(15_000);
			this.flights.set(key, attempt);
			const current = () =>
				this.active && revision === this.detailRevision && this.flights.get(key) === attempt;
			void waitForRead(
				this.options.client.action(api.reviewDetails.detail, {
					membershipId: this.options.membershipId,
					id: this.options.id,
					changeId: row.changeId,
					documentId: this.documentId
				}),
				attempt.signal
			)
				.then((detail) => {
					if (!current()) return;
					if (!detail) {
						this.reset();
						return;
					}
					this.details.delete(key);
					this.details.set(key, detail);
					while (this.details.size > 64) this.details.delete(this.details.keys().next().value!);
					if (!this.failedDetails.size) this.detailError = null;
					this.rows = this.rows.map((value) => (this.key(value) === key ? detail : value));
				})
				.catch((error) => {
					if (current()) {
						this.failedDetails.add(key);
						this.detailError = saveError(error, 'We couldn’t check this review action. Try again.');
					}
				})
				.finally(() => {
					attempt.complete();
					if (!current()) return;
					this.flights.delete(key);
					this.resolveDetails();
				});
		}
	}
	private stopDetailReads() {
		this.detailRevision++;
		const flights = [...this.flights.values()];
		this.flights.clear();
		for (const attempt of flights) attempt.abort();
	}
	reset() {
		this.stopDetailReads();
		this.failedDetails.clear();
		this.attempt?.complete();
		this.attempt = undefined;
		this.timedOut = true;
		queueMicrotask(() => {
			if (this.active && !this.destroyed) this.timedOut = false;
		});
		this.error = null;
		this.detailError = null;
		this.done = false;
		this.revision++;
	}
	loadMore() {
		if (this.active && !this.loading && !this.done && !this.timedOut) this.more?.();
	}
	retryDetails() {
		this.failedDetails.clear();
		this.detailError = null;
		this.resolveDetails();
	}
	destroy() {
		this.active = false;
		this.destroyed = true;
		this.stopDetailReads();
		this.attempt?.abort();
		this.details.clear();
		this.rows = [];
	}
}
