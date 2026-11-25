import { getContext, setContext } from 'svelte';
import { ConvexClient } from 'convex/browser';
import type { FunctionReturnType } from 'convex/server';
import { env } from '$env/dynamic/public';
import { api } from '../../convex/_generated/api';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';
import type { SeenMessage } from '$lib/discussions/reads.svelte';

type Clerk = NonNullable<Window['Clerk']>;
type AccountSession = NonNullable<Clerk['session']>;
type Seller = NonNullable<FunctionReturnType<typeof api.buyerLinks.sellerContext>>;
type SellerAvatar = FunctionReturnType<typeof api.profiles.currentAvatar>;
const key = Symbol('buyer-seller');

/** Classifies the audience and owns the separate authenticated seller transport. */
export class BuyerSeller {
	viewer = $state.raw<Seller | null>(null);
	private avatar = $state.raw<SellerAvatar>();
	private avatarUnavailable = $state(false);
	client = $state.raw<ConvexClient>();
	private buyerPreview = $state(false);
	private previewGeneration = $state(0);
	get preview() {
		return this.buyerPreview;
	}
	set preview(preview: boolean) {
		if (this.buyerPreview === preview) return;
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
	private stopAvatar?: () => void;
	private attempt?: ReadAttempt;
	private generation = $state(0);
	private contextGeneration = $state(0);
	private prepared?: { token: string; expiresAt: number; sessionId: string; generation: number };
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
	get headerReadiness(): 'pending' | 'ready' | 'unavailable' {
		if (this.phase === 'unavailable') return 'unavailable';
		if (this.phase === 'checking' || (this.phase === 'seller' && !this.viewer)) return 'pending';
		return 'ready';
	}
	get headerProfile() {
		const profile = this.viewer?.profile;
		return profile
			? {
					...profile,
					avatarUrl: this.avatar?.id === profile.id ? this.avatar.avatarUrl : null
				}
			: undefined;
	}
	get headerAvatarReady() {
		return (
			this.viewer !== null && (this.avatarUnavailable || this.avatar?.id === this.viewer.profile.id)
		);
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
		return Boolean(this.viewer && !this.preview);
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
		this.prepared = undefined;
		this.attempt?.abort();
		this.stopContext?.();
		this.stopContext = undefined;
		this.stopAvatar?.();
		this.stopAvatar = undefined;
		this.avatar = undefined;
		this.avatarUnavailable = false;
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
							this.preview = false;
						}
						if (this.viewer?.profile.id !== viewer?.profile.id) {
							this.stopAvatar?.();
							this.stopAvatar = undefined;
							this.avatar = undefined;
							this.avatarUnavailable = false;
						}
						this.viewer = viewer;
						this.phase = viewer ? 'seller' : 'buyer';
						if (viewer && !this.stopAvatar) {
							const profileId = viewer.profile.id;
							this.stopAvatar = client.onUpdate(
								api.profiles.currentAvatar,
								{},
								(avatar) => {
									if (
										current() &&
										this.viewer?.profile.id === profileId &&
										avatar.id === profileId
									) {
										this.avatar = avatar;
										this.avatarUnavailable = false;
									}
								},
								() => {
									if (current() && this.viewer?.profile.id === profileId)
										this.avatarUnavailable = true;
								}
							);
						}
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
			!this.visible ||
			!client.connectionState().isWebSocketConnected
		)
			return false;
		const attempt = new ReadAttempt(15_000, this.root?.signal);
		try {
			await waitForRead(
				client.mutation(api.discussions.markSeen, {
					membershipId: viewer.membershipId,
					id: viewer.contractId,
					token: this.token,
					operationId: crypto.randomUUID(),
					messages: messages.map((message) => ({ ...message }))
				}),
				attempt.signal
			);
			return (
				identity === this.identity &&
				accountIdentity === this.accountIdentity &&
				client === this.client
			);
		} finally {
			attempt.complete();
		}
	}
}
export const setBuyerSeller = (seller: BuyerSeller) => setContext(key, seller);
export const getBuyerSeller = () => getContext<BuyerSeller | undefined>(key);
