import { getContext, setContext } from 'svelte';
import type { Availability } from './csm-availability';

type Preview = {
	scope: string;
	timeZone: string;
	pending: Promise<Availability>;
	expiresAt?: number;
};

export function csmPreviewScope(
	userId: string | null | undefined,
	sessionId: string | null | undefined,
	generation: number
) {
	return userId && sessionId ? JSON.stringify([userId, sessionId, generation]) : undefined;
}

/** A single onboarding read lives across the company creation navigation. */
export class CsmOnboardingPreview {
	private preview?: Preview;

	retain(scope?: string) {
		if (this.preview?.scope !== scope) this.preview = undefined;
	}

	start(scope: string, timeZone: string, load: () => Promise<Availability>) {
		const prior = this.preview;
		if (
			prior?.scope === scope &&
			prior.timeZone === timeZone &&
			(prior.expiresAt === undefined || prior.expiresAt > Date.now())
		)
			return;
		const entry: Preview = { scope, timeZone, pending: Promise.resolve().then(load) };
		this.preview = entry;
		entry.pending = entry.pending.then(
			(data) => {
				if (this.preview === entry) {
					if (data.status === 'ready') entry.expiresAt = Date.now() + 120_000;
					else this.preview = undefined;
				}
				return data;
			},
			(error: unknown) => {
				if (this.preview === entry) this.preview = undefined;
				throw error;
			}
		);
		void entry.pending.catch(() => {});
	}

	read(scope: string | undefined, timeZone: string) {
		const entry = this.preview;
		if (
			!scope ||
			entry?.scope !== scope ||
			entry.timeZone !== timeZone ||
			(entry.expiresAt !== undefined && entry.expiresAt <= Date.now())
		)
			return;
		return { pending: entry.pending, expiresAt: () => entry.expiresAt };
	}
}

const key = Symbol('csm-onboarding-preview');
export function setCsmOnboardingPreview() {
	return setContext(key, new CsmOnboardingPreview());
}
export function useCsmOnboardingPreview() {
	return getContext<CsmOnboardingPreview | undefined>(key);
}
