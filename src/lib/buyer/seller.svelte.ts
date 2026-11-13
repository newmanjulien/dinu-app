import { getContext, setContext } from 'svelte';
import { ConvexClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import type { FunctionReturnType } from 'convex/server';
import { env } from '$env/dynamic/public';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import { workBlockMessage } from '$lib/contract/work-policy';
import type { SeenMessage } from '$lib/discussions/reads.svelte';
import { awaitContractOperation } from '$lib/contract/operation-result';
import { reviewOperationInputs } from '$lib/contract/changes';
import type { Value } from 'convex/values';

type Clerk = NonNullable<Window['Clerk']>;
type AccountSession = NonNullable<Clerk['session']>;
type Seller = NonNullable<FunctionReturnType<typeof api.buyerLinks.sellerContext>>;
type SellerOperationKind =
	| 'change-decision'
	| 'proposal-support'
	| 'approval-request'
	| 'review-completion'
	| 'discussion-mark-seen';
type SellerCommand = {
	kind: SellerOperationKind;
	inputs: string;
	send: (client: ConvexClient) => Promise<{ status: 'complete' | 'preparing' }>;
};
type SellerIntent = SellerCommand & {
	operationId: string;
	dispatched: boolean;
	uncertain: boolean;
};
export const nativeSellerCommand = <T extends { status: 'complete' | 'preparing' }>(
	kind: Exclude<SellerOperationKind, 'discussion-mark-seen'>,
	args: Value,
	send: (client: ConvexClient) => Promise<T>
) => ({ kind, inputs: reviewOperationInputs({ kind, args }), send });
const key = Symbol('buyer-seller');

/** Classifies the audience and owns the separate authenticated seller transport. */
export class BuyerSeller {
	viewer = $state.raw<Seller | null>(null);
	client = $state.raw<ConvexClient>();
	private buyerPreview = $state(false);
	private previewGeneration = $state(0);
	get preview() {
		return this.buyerPreview;
	}
	set preview(preview: boolean) {
		if (this.buyerPreview === preview) return;
		for (const waiter of this.operationWaiters) waiter.abort();
		this.previewGeneration++;
		this.buyerPreview = preview;
	}
	get discussionPolicy() {
		return { readOnly: this.preview, generation: this.previewGeneration };
	}
	phase = $state<'checking' | 'buyer' | 'seller' | 'unavailable'>('checking');
	private sessionId = $state<string>();
	private clerk?: Clerk;
	private root?: AbortController;
	private loading = false;
	private unsubscribe?: () => void;
	private stopContext?: () => void;
	private attempt?: ReadAttempt;
	private generation = $state(0);
	private contextGeneration = $state(0);
	private prepared?: { token: string; expiresAt: number; sessionId: string; generation: number };
	private intents = new Map<string, SellerIntent>();
	private operationWaiters = new Set<AbortController>();
	constructor(readonly token: string) {}
	get userId() {
		const session = this.clerk?.session;
		return session && session.id === this.sessionId ? session.user.id : undefined;
	}
	get identity() {
		return this.viewer && this.sessionId
			? JSON.stringify([this.sessionId, this.viewer.profile.id, this.viewer.membershipId])
			: undefined;
	}
	get recoveryIdentity() {
		return JSON.stringify([
			this.sessionId ?? null,
			this.viewer?.profile.id,
			this.viewer?.membershipId
		]);
	}
	get presentation() {
		return this.phase === 'seller' && this.preview ? 'preview' : this.phase;
	}
	get accountIdentity() {
		return JSON.stringify([this.sessionId ?? null, this.generation, this.contextGeneration]);
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
		// This expiry is a flush optimization, never an authorization decision.
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
	get visible() {
		return !!this.viewer && !this.preview;
	}
	async signOut() {
		if (!this.clerk) throw new Error('Authentication is unavailable.');
		await this.clerk.signOut(() => {});
	}
	viewAsBuyer() {
		this.preview = true;
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
			else this.phase = 'buyer';
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
		this.phase = 'checking';
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
			if (!this.root?.signal.aborted) this.phase = 'unavailable';
		} finally {
			attempt.complete();
			this.loading = false;
		}
	}
	private clear() {
		this.generation++;
		for (const waiter of this.operationWaiters) waiter.abort();
		this.prepared = undefined;
		this.attempt?.abort();
		this.stopContext?.();
		this.stopContext = undefined;
		for (const [key, intent] of this.intents) {
			if (!intent.dispatched) this.intents.delete(key);
		}
		this.viewer = null;
		this.preview = false;
		if (this.client) void this.client.close();
		this.client = undefined;
	}
	private align(session: AccountSession | undefined, retry = false) {
		if (this.root?.signal.aborted) return;
		if (this.sessionId === session?.id && !retry && this.phase !== 'checking') return;
		if (this.sessionId === session?.id && this.client && !retry) return;
		this.clear();
		this.sessionId = session?.id;
		if (!session) {
			this.phase = 'buyer';
			return;
		}
		this.phase = 'checking';
		const generation = this.generation;
		const current = () =>
			!this.root?.signal.aborted &&
			generation === this.generation &&
			this.clerk?.session?.id === session.id;
		const client = (this.client = new ConvexClient(env.PUBLIC_CONVEX_URL!, {
			unsavedChangesWarning: false
		}));
		const attempt = (this.attempt = new ReadAttempt(15_000, this.root?.signal));
		const fail = () => {
			if (!current()) return;
			this.clear();
			this.phase = 'unavailable';
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
					api.buyerLinks.sellerContext,
					{ token: this.token },
					(viewer) => {
						if (!current()) return;
						attempt.complete();
						const changed =
							this.viewer?.membershipId !== viewer?.membershipId ||
							this.viewer?.profile.id !== viewer?.profile.id ||
							this.viewer?.role !== viewer?.role;
						if (changed) {
							this.contextGeneration++;
							for (const waiter of this.operationWaiters) waiter.abort();
							this.preview = false;
						}
						this.viewer = viewer;
						this.phase = viewer ? 'seller' : 'buyer';
					},
					fail
				);
			}
		);
	}
	async markMessagesSeen(identity: string, accountIdentity: string, messages: SeenMessage[]) {
		const viewer = this.viewer,
			client = this.client;
		if (
			!viewer ||
			!client ||
			identity !== this.identity ||
			accountIdentity !== this.accountIdentity ||
			!client.connectionState().isWebSocketConnected
		)
			return false;
		await this.perform(
			`seen:${JSON.stringify(messages)}`,
			(original, operationId) => {
				const args = {
					token: this.token,
					operationId,
					messages: messages.map((message) => ({ ...message }))
				};
				return {
					kind: 'discussion-mark-seen',
					inputs: JSON.stringify(args),
					send: (transport) =>
						transport.mutation(api.discussions.markSeen, {
							membershipId: original.membershipId,
							id: original.contractId,
							...args
						})
				};
			},
			false
		);
		return (
			identity === this.identity &&
			accountIdentity === this.accountIdentity &&
			client === this.client
		);
	}
	async perform<
		T extends { status: 'complete' | 'preparing' } = { status: 'complete' | 'preparing' }
	>(
		key: string,
		create: (viewer: Seller, operationId: string) => SellerCommand,
		checkWork = true
	): Promise<T> {
		const viewer = this.viewer,
			client = this.client,
			identity = this.identity,
			accountIdentity = this.accountIdentity,
			previewGeneration = this.previewGeneration;
		if (!viewer || !client || !identity || !this.visible)
			throw new Error('Open the dashboard and sign in to handle proposals.');
		const intentKey = JSON.stringify([identity, key]);
		let intent = this.intents.get(intentKey);
		if (!intent) {
			const operationId = crypto.randomUUID();
			intent = { operationId, dispatched: false, uncertain: false, ...create(viewer, operationId) };
			this.intents.set(intentKey, intent);
		}
		const captured = intent;
		const retire = () => {
			if (this.intents.get(intentKey) === captured) this.intents.delete(intentKey);
		};
		const current = () =>
			identity === this.identity &&
			accountIdentity === this.accountIdentity &&
			client === this.client &&
			previewGeneration === this.previewGeneration &&
			this.visible;
		const lifetime = new AbortController();
		this.operationWaiters.add(lifetime);
		const attempt = new ReadAttempt(15_000, AbortSignal.any([lifetime.signal, this.root!.signal]));
		const receipt = () =>
			awaitContractOperation<T>(
				client,
				{
					membershipId: viewer.membershipId,
					id: viewer.contractId,
					kind: captured.kind,
					operationId: captured.operationId,
					inputs: captured.inputs
				},
				attempt.signal
			);
		try {
			if (!current()) throw new Error('Your seller session changed.');
			if (!captured.dispatched && checkWork) {
				const checked = await waitForRead(
					client.action(api.hubspotDeals.check, {
						membershipId: viewer.membershipId,
						contractId: viewer.contractId
					}),
					attempt.signal
				);
				if (checked.outcome === 'unavailable')
					throw new ConvexError({
						code: 'deal-unavailable',
						message: workBlockMessage('deal-unavailable')
					});
			}
			if (!current()) throw new Error('Your seller session changed.');
			attempt.signal.throwIfAborted();
			captured.dispatched = true;
			let result: T;
			try {
				result = await waitForRead(
					captured.send(client).then((value) => {
						if (value.status === 'complete') retire();
						return value as T;
					}),
					attempt.signal
				);
			} catch (error) {
				if (error instanceof ConvexError) throw error;
				captured.uncertain = true;
				result = await receipt();
			}
			if (result.status === 'preparing') result = await receipt();
			retire();
			return result;
		} catch (error) {
			if (!captured.dispatched || (error instanceof ConvexError && !captured.uncertain)) retire();
			throw error;
		} finally {
			attempt.complete();
			this.operationWaiters.delete(lifetime);
		}
	}
}
export const setBuyerSeller = (seller: BuyerSeller) => setContext(key, seller);
export const getBuyerSeller = () => getContext<BuyerSeller | undefined>(key);
