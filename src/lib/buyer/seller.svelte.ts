import { getContext, setContext } from 'svelte';
import { ConvexClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { env } from '$env/dynamic/public';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';

type Clerk = NonNullable<Window['Clerk']>;
type AccountSession = NonNullable<Clerk['session']>;
const key = Symbol('buyer-seller');
export type BuyerPageContext = Extract<
	FunctionReturnType<typeof api.buyerLinks.pageContext>,
	{ kind: 'current' }
>;

/** Classifies whether the viewer is a buyer or a signed-in company member previewing as buyer. */
export class BuyerSeller {
	phase = $state<'checking' | 'buyer' | 'preview' | 'unavailable'>('checking');
	contractId = $state<Id<'savedContracts'> | null>(null);
	phaseGeneration = $state(0);
	private sessionId = $state<string>();
	private clerk?: Clerk;
	private client?: ConvexClient;
	private root?: AbortController;
	private loading = false;
	private unsubscribe?: () => void;
	private stopContext?: () => void;
	private attempt?: ReadAttempt;
	private generation = $state(0);
	private contextGeneration = $state(0);
	private prepared?: { token: string; expiresAt: number; sessionId: string; generation: number };

	private initialClassification = false;
	constructor(
		readonly token: string,
		initial?: BuyerPageContext
	) {
		if (initial) {
			this.initialClassification = true;
			this.setPhase(
				initial.audience === 'seller' ? 'preview' : 'buyer',
				initial.audience === 'seller' ? initial.contractId : null
			);
		}
	}

	get readOnly() {
		return this.phase !== 'buyer';
	}
	get discussionPolicy() {
		return { readOnly: this.readOnly, generation: this.phaseGeneration };
	}
	get headerReadiness(): 'pending' | 'ready' | 'unavailable' {
		if (this.phase === 'unavailable') return 'unavailable';
		if (this.phase === 'checking' || (this.phase === 'preview' && !this.contractId))
			return 'pending';
		return 'ready';
	}
	get accountIdentity() {
		return JSON.stringify([this.sessionId ?? null, this.generation, this.contextGeneration]);
	}
	get identity() {
		return this.phase === 'preview' && this.sessionId && this.contractId
			? JSON.stringify([this.sessionId, this.contractId])
			: undefined;
	}
	private setPhase(
		phase: 'checking' | 'buyer' | 'preview' | 'unavailable',
		contractId: Id<'savedContracts'> | null = null
	) {
		const changed = this.phase !== phase || this.contractId !== contractId;
		this.phase = phase;
		this.contractId = contractId;
		if (changed) this.phaseGeneration++;
	}
	async activityToken(signal: AbortSignal) {
		if (!this.clerk?.session) {
			if (this.phase === 'buyer') return null;
			throw new Error('Account classification is unavailable.');
		}
		return this.accountToken(signal);
	}
	preparedActivityToken() {
		const prepared = this.prepared;
		return prepared &&
			prepared.sessionId === this.clerk?.session?.id &&
			prepared.generation === this.generation &&
			prepared.expiresAt > Date.now() + 5000
			? prepared.token
			: null;
	}
	private async accountToken(signal: AbortSignal, forceRefresh = false) {
		const session = this.clerk?.session;
		const generation = this.generation;
		if (!session || session.id !== this.sessionId) throw new Error('Your account session changed.');
		const token = await waitForRead(
			session.getToken({ template: 'convex', skipCache: forceRefresh }),
			signal
		);
		if (
			!token ||
			this.root?.signal.aborted ||
			generation !== this.generation ||
			this.clerk?.session?.id !== session.id
		)
			throw new Error('Your account session changed.');
		const payload: { exp?: unknown } = JSON.parse(
			atob(token.split('.')[1].replace(/-/gu, '+').replace(/_/gu, '/'))
		);
		this.prepared = {
			token,
			expiresAt: typeof payload.exp === 'number' ? payload.exp * 1000 : 0,
			sessionId: session.id,
			generation
		};
		return token;
	}
	mount(hasAccountSession: boolean) {
		const root = (this.root = new AbortController());
		const detect = () => {
			if (document.visibilityState !== 'visible') return;
			if (this.clerk) this.align(this.clerk.session ?? undefined, this.phase === 'unavailable');
			else if (
				hasAccountSession ||
				window.Clerk ||
				/(?:^|;\s*)__(?:session|client_uat)(?:_[^=;]+)?=/u.test(document.cookie)
			)
				void this.loadAccount();
			else this.setPhase('buyer');
		};
		window.addEventListener('focus', detect);
		document.addEventListener('visibilitychange', detect);
		detect();
		return () => {
			root.abort();
			this.unsubscribe?.();
			this.clear();
			window.removeEventListener('focus', detect);
			document.removeEventListener('visibilitychange', detect);
		};
	}
	retry() {
		if (!this.root || this.root.signal.aborted) return;
		if (this.clerk) this.align(this.clerk.session ?? undefined, true);
		else void this.loadAccount();
	}
	private async loadAccount() {
		if (this.loading || this.root?.signal.aborted) return;
		this.loading = true;
		if (!this.initialClassification) this.setPhase('checking');
		const attempt = new ReadAttempt(15_000, this.root?.signal);
		try {
			const { existingBuyerAccount } = await waitForRead(
				import('$lib/auth/buyer-discussion-auth'),
				attempt.signal
			);
			const clerk = await existingBuyerAccount(attempt.signal);
			attempt.signal.throwIfAborted();
			this.clerk = clerk;
			this.unsubscribe = clerk.addListener(({ session }) => this.align(session ?? undefined));
		} catch {
			if (!this.root?.signal.aborted) this.setPhase('unavailable');
		} finally {
			attempt.complete();
			this.loading = false;
		}
	}
	private clear() {
		this.generation++;
		this.prepared = undefined;
		this.attempt?.abort();
		this.stopContext?.();
		this.stopContext = undefined;
		this.contractId = null;
		if (this.client) void this.client.close();
		this.client = undefined;
	}
	private align(session: AccountSession | undefined, retry = false) {
		if (this.root?.signal.aborted) return;
		if (
			this.sessionId === session?.id &&
			!retry &&
			this.phase !== 'checking' &&
			!this.initialClassification
		)
			return;
		if (this.sessionId === session?.id && this.client && !retry) return;
		const initial = this.initialClassification
			? { phase: this.phase, contractId: this.contractId }
			: null;
		this.initialClassification = false;
		this.clear();
		this.sessionId = session?.id;
		if (!session) {
			this.setPhase('buyer');
			return;
		}
		if (initial) this.setPhase(initial.phase, initial.contractId);
		else this.setPhase('checking');
		const generation = this.generation;
		const current = () =>
			!this.root?.signal.aborted &&
			generation === this.generation &&
			this.clerk?.session?.id === session.id;
		const client = (this.client = new ConvexClient(env.PUBLIC_CONVEX_URL!, {
			unsavedChangesWarning: false,
			expectAuth: true
		}));
		const attempt = (this.attempt = new ReadAttempt(15_000, this.root?.signal));
		const fail = () => {
			if (!current()) return;
			this.clear();
			this.setPhase('unavailable');
		};
		attempt.signal.addEventListener('abort', fail, { once: true });
		client.setAuth(
			async ({ forceRefreshToken }) => {
				if (!current()) return null;
				const tokenAttempt = new ReadAttempt(15_000, this.root?.signal);
				try {
					const token = await this.accountToken(tokenAttempt.signal, forceRefreshToken);
					if (!token) fail();
					return current() ? token : null;
				} catch {
					fail();
					return null;
				} finally {
					tokenAttempt.complete();
				}
			},
			(authenticated) => {
				if (!current()) return;
				if (!authenticated) {
					fail();
					return;
				}
				if (this.stopContext) return;
				this.stopContext = client.onUpdate(
					api.buyerLinks.pageContext,
					{ token: this.token },
					(context) => {
						if (!current()) return;
						attempt.complete();
						if (context.kind === 'account-error') {
							fail();
							return;
						}
						const nextContractId =
							context.kind === 'current' && context.audience === 'seller'
								? context.contractId
								: null;
						const nextPhase = nextContractId ? 'preview' : 'buyer';
						if (this.phase !== nextPhase || this.contractId !== nextContractId)
							this.contextGeneration++;
						this.setPhase(nextPhase, nextContractId);
					},
					fail
				);
			}
		);
	}
}
export const setBuyerSeller = (seller: BuyerSeller) => setContext(key, seller);
export const getBuyerSeller = () => getContext<BuyerSeller | undefined>(key);
