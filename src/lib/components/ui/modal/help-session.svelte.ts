import {
	createDocumentLoadingOpeningId,
	recordDocumentLoadingMilestone
} from '$lib/document/runtime/render-perf';

type Audience = { identity: string };
export type HelpPolicy =
	| { kind: 'pending' }
	| { kind: 'manual' }
	| (Audience & { kind: 'preview' })
	| (Audience & {
			kind: 'preference';
			confirmation: 'subscription' | 'save';
			hidden: boolean;
			save: (hidden: boolean) => Promise<unknown>;
			current: () => boolean;
	  });

/** One document/link opening, retained through renderer and presentation changes. */
export class HelpSession {
	readonly loadingOpening = createDocumentLoadingOpeningId();
	private policy = $state.raw<HelpPolicy>({ kind: 'pending' });
	private handled = $state(false);
	private admittedOnce = $state(false);
	private active = $state(true);
	private identity?: string;
	private preview = false;
	private destroyed = false;
	private write?: { current: () => boolean };
	open = $state(false);
	hidden = $state(false);
	pending = $state(false);
	error = $state('');

	configure(policy: HelpPolicy) {
		if (this.destroyed) return;
		const firstResolution = this.policy.kind === 'pending' && policy.kind !== 'pending';
		if ('identity' in policy) {
			if (this.identity !== undefined && this.identity !== policy.identity) {
				this.handled = false;
				this.admittedOnce = false;
				this.open = false;
				this.hidden = false;
				this.preview = false;
				this.clearWrite();
			}
			this.identity = policy.identity;
		}
		if (this.write && !this.write.current()) this.clearWrite();
		if (policy.kind === 'preview') {
			if (!this.preview) this.close();
			this.preview = true;
			this.handled = true;
		} else if (policy.kind !== 'pending') this.preview = false;
		if (policy.kind === 'preference') this.hidden = policy.hidden;
		this.policy = policy;
		if (firstResolution)
			recordDocumentLoadingMilestone('help-policy-resolved', {
				opening: this.loadingOpening
			});
		if (this.handled && policy.kind !== 'pending') this.admittedOnce = true;
	}

	get resolved() {
		return this.policy.kind !== 'pending';
	}
	get admitted() {
		return this.admittedOnce;
	}
	/** Temporary holds retain the opening decision, but retire its local write state. */
	setActive(active: boolean) {
		if (this.destroyed || this.active === active) return;
		this.active = active;
		if (!active) {
			this.close();
			this.clearWrite();
		}
	}
	get showCheckbox() {
		return this.policy.kind === 'preference' || this.policy.kind === 'pending';
	}
	get checkboxDisabled() {
		return !this.active || this.policy.kind !== 'preference' || this.pending;
	}
	considerAutomatic() {
		if (this.destroyed || !this.active || this.handled || this.policy.kind === 'pending') return;
		this.handled = true;
		this.admittedOnce = true;
		if (this.policy.kind === 'preference' && !this.hidden) {
			this.open = true;
			recordDocumentLoadingMilestone('help-automatic-open', {
				opening: this.loadingOpening
			});
		}
	}
	openManually() {
		if (this.destroyed || !this.active) return;
		this.handled = true;
		if (this.resolved) this.admittedOnce = true;
		this.open = true;
	}
	close() {
		this.open = false;
	}
	private clearWrite() {
		this.write = undefined;
		this.pending = false;
		this.error = '';
	}
	async setHidden(hidden: boolean) {
		const policy = this.policy;
		if (
			this.destroyed ||
			!this.active ||
			policy.kind !== 'preference' ||
			this.pending ||
			!policy.current()
		)
			return;
		const identity = this.identity;
		const write = (this.write = { current: policy.current });
		this.pending = true;
		this.error = '';
		const current = () => this.write === write && this.identity === identity && policy.current();
		try {
			await policy.save(hidden);
			if (current() && policy.confirmation === 'save') this.hidden = hidden;
		} catch {
			if (current()) this.error = 'Could not save your preference. Please try again.';
		} finally {
			if (this.write === write) {
				this.write = undefined;
				this.pending = false;
			}
		}
	}
	destroy() {
		this.destroyed = true;
		this.clearWrite();
		this.close();
	}
}
