import { getContext, setContext } from 'svelte';
import { ACTIVITY_RETENTION, type ActivityBrowser, type BuyerActivityRequest } from './tracking';

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
	private request?: AbortController;
	private expiry?: ReturnType<typeof setTimeout>;
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
	private enqueue(body: BuyerActivityRequest) {
		if (this.queue.length >= 50) return;
		this.queue.push({ body, at: Date.now(), generation: this.generation });
		void this.drain();
	}
	private async drain() {
		if (this.delivering) return;
		this.delivering = true;
		try {
			while (this.alive && this.queue.length) {
				const entry = this.queue.shift()!;
				const session = this.session;
				if (!session) continue;
				const current = () =>
					this.alive && entry.generation === this.generation && this.session === session;
				let handled = false;
				const controller = (this.request = new AbortController());
				try {
					for (
						let attempt = 0;
						attempt < 4 && current() && Date.now() - entry.at < MAX_AGE;
						attempt++
					) {
						let delay = (attempt + 1) * 1000;
						try {
							const response = await this.send(
								entry.body,
								AbortSignal.any([controller.signal, AbortSignal.timeout(8000)])
							);
							if (!current()) break;
							if (response.ok) {
								if (response.status !== 204) {
									const result: { expiresAt: number } = await response.json();
									if (!current()) break;
									if (entry.body.kind !== 'open') throw new Error('Invalid activity response.');
									if (!Number.isFinite(result.expiresAt))
										throw new Error('Invalid activity expiry.');
									session.expiresAt = result.expiresAt;
									session.opening = 'accepted';
									this.scheduleExpiry();
								}
								handled = true;
								break;
							}
							if (response.status >= 400 && response.status < 500 && response.status !== 429) {
								if (entry.body.kind === 'open') this.stop();
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
				}
				if (current() && !handled) {
					this.queue = [];
					if (entry.body.kind === 'open') session.opening = 'idle';
				}
			}
		} finally {
			this.delivering = false;
		}
	}
	private async send(
		body: BuyerActivityRequest,
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
		for (const entry of this.queue.splice(0, 8))
			if (entry.generation === this.generation && Date.now() - entry.at < MAX_AGE)
				void this.send(entry.body, AbortSignal.timeout(8000), true).catch(() => {});
	};
}
export function setBuyerActivity() {
	return setContext(key, new BuyerActivity());
}
export function getBuyerActivity() {
	return getContext<BuyerActivity | undefined>(key);
}
