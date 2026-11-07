import { ReadAttempt } from './attempt';
import { beginStartupAttempt } from './startup-perf';
import type { SessionEditor, SessionPhase } from './viewer-session.svelte';

/** Owns account readiness, session recovery, and safe editor shutdown across routes. */
export class AccountLifecycle {
	phase = $state<SessionPhase>('loading');
	error = $state('');
	delayed = $state(false);
	transportGeneration = $state(0);
	preparedSessionId = $state<string | null>();
	userId = $state<string | null>(null);
	workspaceAdmitted = $state(false);
	private readAttempt: ReadAttempt | undefined;
	private readFailed = false;
	private authLoading = true;
	private authenticated = false;
	private accountReady = false;
	private accountError = '';
	private editors = new Set<SessionEditor>();
	private generation = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private attempt: Promise<void> | null = null;
	private disposed = false;
	constructor(
		private actions: {
			signOut: () => Promise<void>;
			login: (recover: boolean) => Promise<void>;
			clear: () => void;
			cancelReads: () => void;
		}
	) {}

	get closing() {
		return this.phase === 'signed-out';
	}
	get blocked() {
		return this.phase !== 'ready';
	}
	start() {
		this.startReadAttempt();
		this.startTimer();
	}
	private setPhase(phase: SessionPhase) {
		if (this.phase === phase) return;
		this.phase = phase;
		this.startReadAttempt();
		this.startTimer();
		this.syncEditors();
	}
	private startReadAttempt() {
		const previous = this.readAttempt;
		this.readAttempt = undefined;
		previous?.abort();
		if (!['loading', 'authenticating', 'preparing'].includes(this.phase)) return;
		const attempt = new ReadAttempt(15_000);
		this.readAttempt = attempt;
		attempt.signal.addEventListener(
			'abort',
			() => {
				if (this.disposed || this.readAttempt !== attempt) return;
				this.readAttempt = undefined;
				this.readFailed = true;
				this.error = 'We couldn’t connect your account. Try again or log out.';
				this.actions.cancelReads();
				this.setPhase('authentication-error');
			},
			{ once: true }
		);
	}
	private startTimer() {
		if (
			['loading', 'authenticating', 'preparing', 'saving-before-logout', 'signing-out'].includes(
				this.phase
			)
		) {
			if (this.timer || this.delayed) return;
			this.timer = setTimeout(() => {
				this.timer = undefined;
				this.delayed = true;
			}, 10_000);
		} else {
			clearTimeout(this.timer);
			this.timer = undefined;
			this.delayed = false;
		}
	}
	private syncEditors() {
		for (const editor of this.editors) {
			editor.freeze(this.blocked);
			if (
				this.authenticated &&
				!this.authLoading &&
				this.accountReady &&
				!this.accountError &&
				['ready', 'saving-before-logout', 'saving-before-company-exit'].includes(this.phase)
			)
				editor.resume();
			else editor.suspend();
		}
	}
	registerEditor(editor: SessionEditor) {
		this.editors.add(editor);
		this.syncEditors();
		return () => this.editors.delete(editor);
	}
	identity(sessionId: string | null, userId: string | null, loaded: boolean) {
		if (!loaded) return;
		if (this.preparedSessionId === sessionId && this.userId === userId) return;
		const previous = this.preparedSessionId;
		this.readFailed = false;
		const voluntary = this.phase === 'signing-out';
		this.generation++;
		this.actions.cancelReads();
		if (previous && sessionId) this.actions.clear();
		this.transportGeneration++;
		this.attempt = null;
		for (const editor of this.editors) {
			editor.suspend();
			editor.restartTransport();
		}
		this.authLoading = true;
		this.authenticated = false;
		this.accountReady = false;
		this.workspaceAdmitted = false;
		this.accountError = '';
		this.error = '';
		this.preparedSessionId = sessionId;
		this.userId = userId;
		if (sessionId) {
			this.setPhase('authenticating');
			this.startReadAttempt();
		} else if (previous) this.end(!voluntary);
		else this.setPhase('signed-out');
	}
	reportAuth(loading: boolean, authenticated: boolean) {
		this.authLoading = loading;
		this.authenticated = authenticated;
		this.updatePhase();
	}
	reportAccount(ready: boolean, error = '') {
		this.accountReady = ready;
		this.accountError = error;
		this.updatePhase();
	}
	private updatePhase() {
		if (this.readFailed) {
			this.syncEditors();
			return;
		}
		if (
			['saving-before-logout', 'saving-before-company-exit', 'signing-out', 'signed-out'].includes(
				this.phase
			)
		) {
			this.syncEditors();
			return;
		}
		if (this.authLoading) this.setPhase('authenticating');
		else if (!this.authenticated) this.setPhase('authentication-error');
		else if (this.accountError) this.setPhase('authentication-error');
		else this.setPhase(this.accountReady ? 'ready' : 'preparing');
		if (this.phase === 'ready' && !this.workspaceAdmitted) {
			this.workspaceAdmitted = true;
		}
		this.syncEditors();
	}
	get authenticationError() {
		return (
			this.error || this.accountError || 'We couldn’t connect your account. Try again or log out.'
		);
	}
	retryAuth() {
		if (this.attempt || !this.preparedSessionId || this.disposed) return;
		this.actions.cancelReads();
		this.readFailed = false;
		beginStartupAttempt();
		this.authLoading = true;
		this.authenticated = false;
		this.accountReady = false;
		this.accountError = '';
		this.error = '';
		this.setPhase('authenticating');
		this.startReadAttempt();
		for (const editor of this.editors) editor.restartTransport();
		this.transportGeneration++;
	}
	async exitCompany(action: () => Promise<unknown>, discard = false) {
		if (this.blocked || this.attempt || this.disposed)
			throw new Error('Please wait until your account is ready.');
		const generation = ++this.generation;
		this.setPhase('saving-before-company-exit');
		try {
			for (const editor of this.editors) {
				if (!this.current(generation)) throw new Error('Your session changed. Please try again.');
				if (discard) {
					editor.suspend();
					editor.discard();
				} else {
					editor.retry();
					if (editor.pending && !(await editor.prepareToLeave()))
						throw new Error(
							'Your changes could not be saved. Retry leaving, or discard your changes and leave.'
						);
				}
			}
			if (!this.current(generation)) throw new Error('Your session changed. Please try again.');
			await action();
		} finally {
			if (this.current(generation)) {
				this.setPhase('preparing');
				this.updatePhase();
			}
		}
	}

	signOut() {
		if (this.attempt || this.phase === 'signed-out' || this.disposed)
			return this.attempt ?? Promise.resolve();
		const generation = ++this.generation;
		this.error = '';
		this.setPhase('saving-before-logout');
		const work = this.runSignOut(generation);
		this.attempt = work;
		void work.finally(() => {
			if (this.attempt === work) this.attempt = null;
		});
		return work;
	}
	private current(generation: number) {
		return !this.disposed && generation === this.generation;
	}
	private async runSignOut(generation: number) {
		// Assign the shared attempt before any provider call can change identity.
		await Promise.resolve();
		try {
			for (const editor of this.editors) {
				if (!this.current(generation)) return;
				editor.retry();
				if (editor.pending && !(await editor.prepareToLeave())) {
					if (this.current(generation))
						this.error = 'Your changes haven’t been saved. Retry, cancel logout, or discard them.';
					return;
				}
			}
			if (!this.current(generation)) return;
			this.setPhase('signing-out');
			await this.actions.signOut();
			if (this.current(generation)) this.end(false);
		} catch {
			if (!this.current(generation)) return;
			this.error = 'Unable to log out. Please try again.';
			this.setPhase(this.readFailed ? 'authentication-error' : 'preparing');
			this.updatePhase();
		}
	}
	cancelSignOut() {
		if (this.phase !== 'saving-before-logout') return;
		this.generation++;
		this.attempt = null;
		this.error = '';
		this.setPhase(this.readFailed ? 'authentication-error' : 'preparing');
		this.updatePhase();
	}
	discardAndSignOut() {
		if (this.phase !== 'saving-before-logout') return;
		this.generation++;
		this.attempt = null;
		for (const editor of this.editors) editor.suspend();
		for (const editor of this.editors) editor.discard();
		void this.signOut();
	}
	reset(recover = true) {
		if (this.phase !== 'signed-out') this.end(recover);
		else this.navigate(recover);
	}
	private end(recover: boolean) {
		this.generation++;
		this.attempt = null;
		this.workspaceAdmitted = false;
		this.readFailed = false;
		this.setPhase('signed-out');
		this.actions.clear();
		this.navigate(recover);
	}
	private navigate(recover: boolean) {
		const generation = this.generation;
		void this.actions.login(recover).catch(() => {
			if (this.current(generation)) this.error = 'We couldn’t open the login page.';
		});
	}
	returnToLogin() {
		this.navigate(false);
	}
	dismissError() {
		this.error = '';
	}
	destroy() {
		this.disposed = true;
		this.readAttempt?.abort();
		this.actions.cancelReads();
		this.generation++;
		clearTimeout(this.timer);
		for (const editor of this.editors) editor.suspend();
	}
}
