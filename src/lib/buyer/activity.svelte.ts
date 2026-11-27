import { getContext, setContext } from 'svelte';
import { MAX_CLAUSE_BATCH } from './activity-transport';
import {
	ACTIVITY_RETENTION,
	type ActivityBrowser,
	type BuyerActivityRequest,
	type BuyerClauseBatchRequest
} from './tracking';

type Session = {
	token: string;
	browserId: string;
	openingId: string;
	expiresAt: number;
	opening: 'idle' | 'pending' | 'accepted';
	sequence: number;
	lastActivitySentAt: number;
};
type Pending = { body: BuyerActivityRequest; at: number; generation: number };
const key = Symbol('buyer-activity');
const MAX_AGE = 120_000;
const CLAUSE_BATCH_DELAY_MS = 150;
type ActivityAccount = {
	activityToken: (signal: AbortSignal) => Promise<string | null>;
	preparedActivityToken: () => string | null;
};

function waitForRetry(delay: number, signal: AbortSignal) {
	return new Promise<void>((resolve) => {
		const complete = () => {
			clearTimeout(timer);
			signal.removeEventListener('abort', complete);
			resolve();
		};
		const timer = setTimeout(complete, delay);
		signal.addEventListener('abort', complete, { once: true });
		if (signal.aborted) complete();
	});
}

function batchRetry(value: unknown, count: number) {
	if (!value || typeof value !== 'object' || !('results' in value) || !Array.isArray(value.results))
		throw new Error('Invalid activity batch response.');
	const results: unknown[] = value.results;
	if (results.length !== count) throw new Error('Invalid activity batch response.');
	let limitedAt = -1;
	let retryAfter = 0;
	for (const [index, outcome] of results.entries()) {
		if (!outcome || typeof outcome !== 'object' || !('kind' in outcome))
			throw new Error('Invalid activity batch outcome.');
		if (limitedAt >= 0) {
			if (outcome.kind !== 'deferred') throw new Error('Invalid activity batch outcome.');
		} else if (outcome.kind === 'limited') {
			if (
				!('retryAfter' in outcome) ||
				typeof outcome.retryAfter !== 'number' ||
				!Number.isFinite(outcome.retryAfter)
			)
				throw new Error('Invalid activity batch outcome.');
			limitedAt = index;
			retryAfter = outcome.retryAfter;
		} else if (outcome.kind !== 'recorded' && outcome.kind !== 'unavailable') {
			throw new Error('Invalid activity batch outcome.');
		}
	}
	return limitedAt < 0 ? null : { limitedAt, retryAfter };
}

/** Best-effort page activity. Event history is never persisted in browser storage. */
export class BuyerActivity {
	private account?: ActivityAccount;
	private owner?: string;
	private eligible = false;
	private token?: string;
	private session?: Session;
	private alive = false;
	private generation = 0;
	private delivering = false;
	private queue: Pending[] = [];
	private inFlight: Pending[] = [];
	private request?: AbortController;
	private expiry?: ReturnType<typeof setTimeout>;
	private batchTimer?: ReturnType<typeof setTimeout>;
	private batchWait?: () => void;
	setAccount(account: ActivityAccount) {
		this.account = account;
		return () => {
			if (this.account === account) this.account = undefined;
		};
	}

	mount() {
		this.alive = true;
		document.addEventListener('visibilitychange', this.visible);
		document.addEventListener('scroll', this.interacted, { capture: true, passive: true });
		document.addEventListener('pointerdown', this.interacted);
		document.addEventListener('keydown', this.interacted);
		window.addEventListener('pagehide', this.flush);
		this.visible();
		return () => {
			this.flush();
			this.alive = false;
			this.stop();
			document.removeEventListener('visibilitychange', this.visible);
			document.removeEventListener('scroll', this.interacted, true);
			document.removeEventListener('pointerdown', this.interacted);
			document.removeEventListener('keydown', this.interacted);
			window.removeEventListener('pagehide', this.flush);
		};
	}
	observe(token: string, eligible: boolean, browser: ActivityBrowser = null, owner?: string) {
		if (this.owner !== owner) {
			this.stop();
			this.owner = owner;
		}
		if (this.token !== token || (eligible && !this.session)) {
			this.stop();
			this.token = token;
			const current = browser && browser.expiresAt > Date.now() ? browser : null;
			this.session = {
				token,
				browserId: current?.browserId ?? crypto.randomUUID(),
				openingId: crypto.randomUUID(),
				expiresAt: current?.expiresAt ?? Date.now() + ACTIVITY_RETENTION,
				opening: 'idle',
				sequence: 0,
				lastActivitySentAt: Date.now()
			};
			this.scheduleExpiry();
		}
		this.eligible = eligible;
		if (!eligible) {
			this.cancel();
			if (this.session?.opening === 'pending') this.session.opening = 'idle';
			return;
		}
		this.visible();
	}
	private cancel() {
		this.generation++;
		this.queue = [];
		this.inFlight = [];
		this.releaseBatchWait();
		this.request?.abort();
	}
	private stop() {
		this.cancel();
		this.session = undefined;
		clearTimeout(this.expiry);
	}
	private scheduleExpiry() {
		clearTimeout(this.expiry);
		if (this.session)
			this.expiry = setTimeout(
				() => {
					if (this.session && this.session.expiresAt > Date.now()) {
						this.scheduleExpiry();
						return;
					}
					this.stop();
				},
				Math.min(2_147_483_647, Math.max(0, this.session.expiresAt - Date.now()))
			);
	}
	private visible = () => {
		const session = this.session;
		if (
			!this.alive ||
			!this.eligible ||
			!session ||
			session.opening !== 'idle' ||
			session.expiresAt <= Date.now() ||
			document.visibilityState !== 'visible'
		)
			return;
		session.opening = 'pending';
		this.enqueue({
			kind: 'open',
			token: session.token,
			browserId: session.browserId,
			openingId: session.openingId
		});
	};
	private interacted = (event: Event) => {
		const session = this.session;
		if (
			!event.isTrusted ||
			!this.alive ||
			!this.eligible ||
			!session ||
			session.opening !== 'accepted' ||
			session.expiresAt <= Date.now() ||
			document.visibilityState !== 'visible' ||
			Date.now() - session.lastActivitySentAt < 60_000
		)
			return;
		session.lastActivitySentAt = Date.now();
		this.enqueue({
			kind: 'active',
			token: session.token,
			browserId: session.browserId,
			openingId: session.openingId
		});
	};
	clauseOpened(token: string, itemId: string) {
		const session = this.session;
		if (
			!this.alive ||
			!this.eligible ||
			!session ||
			token !== session.token ||
			session.expiresAt <= Date.now() ||
			document.visibilityState !== 'visible'
		)
			return;
		this.visible();
		this.enqueue({
			kind: 'clause',
			token,
			browserId: session.browserId,
			openingId: session.openingId,
			eventId: crypto.randomUUID(),
			sequence: ++session.sequence,
			itemId
		});
	}
	private headClauses() {
		let count = 0;
		while (
			count < Math.min(this.queue.length, MAX_CLAUSE_BATCH) &&
			this.queue[count].body.kind === 'clause'
		)
			count++;
		return count;
	}
	private releaseBatchWait() {
		clearTimeout(this.batchTimer);
		this.batchTimer = undefined;
		this.batchWait?.();
		this.batchWait = undefined;
	}
	private waitForBatch() {
		return new Promise<void>((resolve) => {
			this.batchWait = resolve;
			this.batchTimer = setTimeout(() => this.releaseBatchWait(), CLAUSE_BATCH_DELAY_MS);
		});
	}
	private batchBody(entries: Pending[]): BuyerClauseBatchRequest {
		const first = entries[0].body;
		if (first.kind !== 'clause') throw new Error('Expected clause activity.');
		return {
			kind: 'clauses',
			token: first.token,
			browserId: first.browserId,
			openingId: first.openingId,
			events: entries.map(({ body }) => {
				if (body.kind !== 'clause') throw new Error('Expected clause activity.');
				return { eventId: body.eventId, sequence: body.sequence, itemId: body.itemId };
			})
		};
	}
	private enqueue(body: BuyerActivityRequest) {
		if (this.queue.length >= 50) return;
		this.queue.push({ body, at: Date.now(), generation: this.generation });
		if (this.headClauses() === MAX_CLAUSE_BATCH) this.releaseBatchWait();
		void this.drain();
	}
	private async drain() {
		if (this.delivering) return;
		this.delivering = true;
		try {
			while (this.alive && this.queue.length) {
				if (Date.now() - this.queue[0].at >= MAX_AGE) {
					this.queue.shift();
					continue;
				}
				if (this.queue[0].body.kind === 'clause' && this.headClauses() < MAX_CLAUSE_BATCH)
					await this.waitForBatch();
				if (!this.alive || !this.queue.length) break;
				const entries = this.queue.splice(
					0,
					this.queue[0].body.kind === 'clause' ? this.headClauses() : 1
				);
				this.inFlight = entries;
				const first = entries[0];
				const session = this.session;
				if (!session) {
					this.inFlight = [];
					continue;
				}
				const current = () =>
					this.alive && first.generation === this.generation && this.session === session;
				let handled = false;
				let remaining = entries;
				const controller = (this.request = new AbortController());
				try {
					for (
						let attempt = 0;
						attempt < 4 && current() && Date.now() - remaining[0].at < MAX_AGE;
						attempt++
					) {
						let delay = (attempt + 1) * 1000;
						try {
							const body = first.body.kind === 'clause' ? this.batchBody(remaining) : first.body;
							const response = await this.send(
								body,
								AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])
							);
							if (!current()) break;
							if (response.ok) {
								if (body.kind === 'clauses') {
									if (response.status !== 200) throw new Error('Invalid activity response.');
									const result: unknown = await response.json();
									if (!current()) break;
									const retry = batchRetry(result, remaining.length);
									if (retry) {
										remaining = remaining.slice(retry.limitedAt);
										this.inFlight = remaining;
										delay = Math.min(10_000, Math.max(delay, retry.retryAfter * 1000));
									} else {
										handled = true;
										break;
									}
								} else if (response.status !== 204) {
									const result: { expiresAt: number } = await response.json();
									if (!current()) break;
									if (first.body.kind !== 'open') throw new Error('Invalid activity response.');
									if (!Number.isFinite(result.expiresAt))
										throw new Error('Invalid activity expiry.');
									session.expiresAt = result.expiresAt;
									session.opening = 'accepted';
									this.scheduleExpiry();
								}
								if (body.kind !== 'clauses') {
									handled = true;
									break;
								}
							}
							if (response.status >= 400 && response.status < 500 && response.status !== 429) {
								if (first.body.kind === 'open') this.stop();
								handled = true;
								break;
							}
							if (response.status === 429)
								delay = Math.min(
									10_000,
									Math.max(delay, Number(response.headers.get('retry-after') ?? 0) * 1000 || delay)
								);
						} catch {
							/* Transient failure; bounded same-ID retry. */
						}
						if (!current() || attempt === 3) break;
						await waitForRetry(delay, controller.signal);
					}
				} finally {
					if (this.request === controller) this.request = undefined;
					this.inFlight = [];
				}
				if (current() && !handled) {
					this.queue = [];
					if (first.body.kind === 'open') session.opening = 'idle';
				}
			}
		} finally {
			this.delivering = false;
		}
	}
	private async send(
		body: BuyerActivityRequest | BuyerClauseBatchRequest,
		signal = AbortSignal.timeout(8000),
		flush = false
	) {
		const account = this.account;
		const token = flush ? account?.preparedActivityToken() : await account?.activityToken(signal);
		signal.throwIfAborted();
		if (account !== this.account) throw new Error('Activity account changed.');
		return fetch('/api/buyer/activity', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(token ? { Authorization: `Bearer ${token}` } : {})
			},
			credentials: 'same-origin',
			cache: 'no-store',
			keepalive: true,
			signal,
			body: JSON.stringify(body)
		});
	}
	private flush = () => {
		if (!this.eligible || !this.session || this.session.expiresAt <= Date.now()) return;
		this.releaseBatchWait();
		const pending = [...this.inFlight, ...this.queue.splice(0)].filter(
			(entry) => entry.generation === this.generation && Date.now() - entry.at < MAX_AGE
		);
		for (let index = 0; index < pending.length;) {
			const entry = pending[index];
			if (entry.body.kind !== 'clause') {
				void this.send(entry.body, AbortSignal.timeout(8000), true).catch(() => {});
				index++;
				continue;
			}
			let end = index + 1;
			while (
				end < pending.length &&
				end - index < MAX_CLAUSE_BATCH &&
				pending[end].body.kind === 'clause'
			)
				end++;
			void this.send(
				this.batchBody(pending.slice(index, end)),
				AbortSignal.timeout(8000),
				true
			).catch(() => {});
			index = end;
		}
	};
}
export function setBuyerActivity() {
	return setContext(key, new BuyerActivity());
}
export function getBuyerActivity() {
	return getContext<BuyerActivity | undefined>(key);
}
