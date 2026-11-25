import {
	createDocumentLoadingOpeningId,
	recordDocumentLoadingMilestone
} from '$lib/document/runtime/render-perf';
import { helpContent, type HelpContent, type HelpVariant } from './help-content';

export type HelpPolicy =
	| { kind: 'pending' }
	| { kind: 'manual'; variant: HelpVariant; identity?: string }
	| {
			kind: 'preference';
			variant: HelpVariant;
			identity: string;
			hidden: boolean;
			save: (hidden: boolean) => Promise<unknown>;
			current: () => boolean;
	  };

/** One document/link opening, retained through renderer and presentation changes. */
export class HelpSession {
	readonly loadingOpening = createDocumentLoadingOpeningId();
	private policy = $state.raw<HelpPolicy>({ kind: 'pending' });
	private handled = $state(false);
	private admittedOnce = $state(false);
	private active = $state(true);
	private identity?: string;
	private destroyed = false;
	private write?: { current: () => boolean };
	open = $state(false);
	hidden = $state(false);
	pending = $state(false);
	error = $state('');

	configure(policy: HelpPolicy) {
		if (this.destroyed) return;
		const previousVariant = this.variant;
		const firstResolution = this.policy.kind === 'pending' && policy.kind !== 'pending';
		if ('identity' in policy && policy.identity !== undefined) {
			if (this.identity !== undefined && this.identity !== policy.identity) {
				this.handled = false;
				this.admittedOnce = false;
				this.open = false;
				this.hidden = false;
				this.clearWrite();
			}
			this.identity = policy.identity;
		}
		if (this.write && !this.write.current()) this.clearWrite();
		if (
			policy.kind === 'pending' ||
			(previousVariant !== undefined && previousVariant !== policy.variant)
		)
			this.close();
		if (policy.kind === 'preference') this.hidden = policy.hidden;
		this.policy = policy;
		if (firstResolution)
			recordDocumentLoadingMilestone('help-policy-resolved', {
				opening: this.loadingOpening
			});
		if (this.handled && policy.kind !== 'pending') this.admittedOnce = true;
	}

	get variant(): HelpVariant | undefined {
		return this.policy.kind === 'pending' ? undefined : this.policy.variant;
	}
	get content(): HelpContent | undefined {
		return this.policy.kind === 'pending' ? undefined : helpContent[this.policy.variant];
	}
	get title(): string {
		return this.content?.title ?? 'Help';
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
		return this.policy.kind === 'preference';
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
		if (this.destroyed || !this.active || !this.resolved) return;
		this.handled = true;
		this.admittedOnce = true;
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
