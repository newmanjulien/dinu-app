import { getContext, setContext } from 'svelte';
import { HelpSession } from '$lib/components/ui/modal/help-session.svelte';
import type { SnapshotClient } from '$lib/query-once';
import type { FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { queryOnce } from '$lib/query-once';
import { ReadAttempt } from '$lib/auth/attempt';
import { afterPaint, DocumentScheduler, type Priority } from '$lib/document/runtime/scheduler';
import type { PresentationOutcome } from '$lib/auth/workspace-presentation.svelte';
import { recordColdStart } from '$lib/document/runtime/render-perf';
import { BuyerDownload } from './download.svelte';
import type { DocumentToolControls } from '$lib/components/document/document-tools';

export type BuyerDocumentState = FunctionReturnType<typeof api.buyerLinks.currentState>;
export type BuyerTemplateContent = FunctionReturnType<typeof api.buyerLinks.templateContent>;
export type BuyerDocumentContent = BuyerDocumentState & {
	blocks: BuyerTemplateContent['blocks'];
	rawExplanations: BuyerTemplateContent['explanations'];
};

type Content = BuyerDocumentContent;
type Host = typeof import('./BuyerDocumentHost.svelte').default;
type FailureStage =
	'content' | 'code' | 'construction' | 'source' | 'preparation' | 'page-mount' | 'opening';
const key = Symbol('buyer-contract');

/** One buyer-link shell; each document opening owns its preparation and capabilities. */
export class BuyerContract {
	readonly help = new HelpSession();
	buyerName = $state<string | null>(null);
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
		const owner = (this.displayOwner = Symbol('displayed-document'));
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
	headerPresented = $state(false);
	connected = $state(false);
	mountReady = $state(false);
	error = $state<string | null>(null);
	refreshError = $state<string | null>(null);
	generation = $state(0);
	scheduler = $state.raw(this.createScheduler());
	readonly priority: Priority = () => 'foreground';
	readonly download: BuyerDownload;
	private stopDocument?: () => void;
	private templates = new Map<Id<'templateVersions'>, BuyerTemplateContent>();
	private templateReads = new Map<Id<'templateVersions'>, Promise<BuyerTemplateContent>>();
	private latestStateSeq = 0;
	tools = $state.raw<DocumentToolControls>();
	private toolsOwner?: symbol;
	private lifetime?: AbortController;
	private opening?: ReadAttempt;
	private presentation: PresentationOutcome = 'pending';
	private presentationRevision = 0;
	private openedAt = 0;
	private failureStage?: FailureStage;
	private code?: Promise<Host>;
	private destroyed = false;

	constructor(
		readonly token: string,
		private client: SnapshotClient
	) {
		this.download = new BuyerDownload(token, this);
	}
	bindTools(generation: number, tools: DocumentToolControls) {
		if (generation !== this.generation || !this.allowed || !this.foreground || this.error)
			return () => {};
		const owner = (this.toolsOwner = Symbol('buyer-tools'));
		this.tools = tools;
		return () => {
			if (this.toolsOwner === owner) this.tools = undefined;
		};
	}
	get foreground() {
		return Boolean(this.target);
	}
	private createScheduler() {
		return new DocumentScheduler();
	}
	/** Shell speculation shares code only; access still owns every content/render lifetime. */
	warmCode() {
		if (this.destroyed) return;
		void this.loadCode().catch(() => {});
	}
	private loadCode(): Promise<Host> {
		if (!this.code) {
			const startedAt = performance.now();
			recordColdStart('buyer-viewer-code-start');
			const code = import('./BuyerDocumentHost.svelte')
				.then((module) => {
					if (!this.destroyed) recordColdStart('buyer-viewer-code-ready', startedAt);
					return module.default;
				})
				.catch((error) => {
					if (this.code === code) this.code = undefined;
					throw error;
				});
			this.code = code;
		}
		return this.code;
	}
	private loadTemplate(
		templateVersionId: Id<'templateVersions'>,
		signal: AbortSignal
	): Promise<BuyerTemplateContent> {
		const cached = this.templates.get(templateVersionId);
		if (cached) return Promise.resolve(cached);
		const existing = this.templateReads.get(templateVersionId);
		if (existing) return existing;
		const read = queryOnce(
			this.client,
			api.buyerLinks.templateContent,
			{ token: this.token, templateVersionId },
			signal
		)
			.then((value) => {
				this.templates.set(templateVersionId, value);
				return value;
			})
			.finally(() => {
				if (this.templateReads.get(templateVersionId) === read)
					this.templateReads.delete(templateVersionId);
			});
		this.templateReads.set(templateVersionId, read);
		return read;
	}
	setAccess(allowed: boolean) {
		if (this.allowed === allowed) return;
		this.allowed = allowed;
		if (!allowed) {
			this.release();
			this.content = undefined;
			this.templates.clear();
			this.templateReads.clear();
			this.Host = undefined;
			this.error = null;
		} else if (this.foreground) this.start();
	}
	attach(target: HTMLElement) {
		if (this.target && this.target !== target) this.release();
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
			this.release();
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
		if (this.content && this.foreground) this.subscribeState(this.generation);
		if (!this.allowed || this.error || this.lifetime) return;
		const lifetime = (this.lifetime = new AbortController());
		const generation = this.generation;
		const startedAt = performance.now();
		if (this.foreground && !this.opening) this.beginOpening();
		if (!this.content) recordColdStart('buyer-content-start');
		const content = this.content
			? Promise.resolve(this.content)
			: new Promise<void>((resolve, reject) => {
					const onAbort = () => reject(lifetime.signal.reason ?? new Error('Aborted'));
					lifetime.signal.addEventListener('abort', onAbort, { once: true });
					this.subscribeState(generation, {
						onFirstReady: () => {
							lifetime.signal.removeEventListener('abort', onAbort);
							recordColdStart('buyer-content-ready', startedAt);
							resolve();
						},
						onFirstError: (error) => {
							lifetime.signal.removeEventListener('abort', onAbort);
							reject(error);
						}
					});
				}).catch(() => {
					if (this.isCurrent(generation, lifetime)) this.fail(generation, 'content');
				});
		const code = this.Host
			? Promise.resolve(this.Host)
			: this.loadCode()
					.then((Host) => {
						if (this.isCurrent(generation, lifetime)) {
							this.Host = Host;
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
	private subscribeState(
		generation: number,
		initial?: { onFirstReady: () => void; onFirstError: (error: unknown) => void }
	) {
		if (this.stopDocument || !this.allowed || !this.foreground) return;
		let active = true;
		let settledInitial = !initial;
		let unsubscribe: (() => void) | undefined;
		const subscriptionAbort = new AbortController();
		this.stopDocument = () => {
			active = false;
			subscriptionAbort.abort();
			unsubscribe?.();
		};
		const applyState = (state: BuyerDocumentState) => {
			if (!active || generation !== this.generation || !this.allowed || !this.foreground) return;
			this.refreshError = null;
			if (this.content && state.displayIdentity === this.content.displayIdentity) return;
			const cachedTemplate = this.templates.get(state.templateVersionId);
			if (cachedTemplate) {
				this.content = {
					...state,
					blocks: cachedTemplate.blocks,
					rawExplanations: cachedTemplate.explanations
				};
				if (!settledInitial) {
					settledInitial = true;
					initial?.onFirstReady();
				}
				return;
			}
			const seq = ++this.latestStateSeq;
			const readAttempt = new ReadAttempt(15_000, subscriptionAbort.signal);
			void this.loadTemplate(state.templateVersionId, readAttempt.signal)
				.then((template) => {
					if (
						!active ||
						seq !== this.latestStateSeq ||
						generation !== this.generation ||
						!this.allowed ||
						!this.foreground
					)
						return;
					this.content = {
						...state,
						blocks: template.blocks,
						rawExplanations: template.explanations
					};
					if (!settledInitial) {
						settledInitial = true;
						initial?.onFirstReady();
					}
				})
				.catch((error) => {
					if (!active || generation !== this.generation || !this.allowed || !this.foreground)
						return;
					if (!settledInitial) {
						settledInitial = true;
						initial?.onFirstError(error);
					} else {
						this.refreshError = 'We couldn’t refresh this contract. Try again.';
					}
				})
				.finally(() => readAttempt.complete());
		};
		const fail = (error: unknown) => {
			if (!active || generation !== this.generation || !this.allowed || !this.foreground) return;
			if (!settledInitial) {
				settledInitial = true;
				initial?.onFirstError(error);
			} else {
				this.refreshError = 'We couldn’t refresh this contract. Try again.';
			}
		};
		unsubscribe = this.client.onUpdate(
			api.buyerLinks.currentState,
			{ token: this.token },
			applyState,
			fail
		);
		if (!active) unsubscribe();
	}

	retryDocument() {
		this.stopDocument?.();
		this.stopDocument = undefined;
		this.templateReads.clear();
		this.refreshError = null;
		this.subscribeState(this.generation);
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
		// A completed attempt has no timer. Layout invalidation needs a new bounded attempt,
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
		this.tools = undefined;
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
		this.tools = undefined;
		this.toolsOwner = undefined;
		this.stopDocument?.();
		this.stopDocument = undefined;
		this.download.reset();
		this.displayed = undefined;
		// Clear identity before aborting, so obsolete callbacks cannot fail the next generation.
		this.generation++;
		const opening = this.opening;
		this.opening = undefined;
		opening?.abort();
		this.templateReads.clear();
		this.lifetime?.abort();
		this.lifetime = undefined;
		this.mountReady = false;
		this.presentation = 'pending';
		this.scheduler.destroy();
		this.scheduler = this.createScheduler();
	}
	destroy() {
		this.help.destroy();
		this.destroyed = true;
		this.code = undefined;
		this.allowed = false;
		this.release();
		this.download.destroy();
		this.toolsOwner = undefined;
		this.scheduler.destroy();
		this.content = undefined;
		this.templates.clear();
		this.templateReads.clear();
		this.Host = undefined;
		this.target = undefined;
	}
}

export const setBuyerContract = (contract: BuyerContract) => setContext(key, contract);
export const getBuyerContract = () => getContext<BuyerContract>(key);
