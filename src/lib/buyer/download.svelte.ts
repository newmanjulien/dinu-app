import { downloadWord } from '$lib/document/export/download';
import { ReadAttempt, waitForRead } from '$lib/auth/attempt';

const DOWNLOAD_ACQUISITION_TIMEOUT_MS = 60_000;

type DownloadState = {
	readonly allowed: boolean;
	readonly foreground: boolean;
	readonly connected: boolean;
	readonly displayed?: { displayIdentity: string };
};

/** The server download belongs to the attached route, independently of its viewer. */
export class BuyerDownload {
	error = $state<string | null>(null);
	private request = $state.raw<ReadAttempt>();
	private alive = true;

	constructor(
		private token: string,
		private state: DownloadState
	) {}

	get reason() {
		return this.request
			? 'Preparing Word document…'
			: !this.state.connected
				? 'Reconnect to download.'
				: !this.state.allowed || !this.state.displayed
					? 'Downloading is unavailable. You can still review the contract.'
					: null;
	}

	private owns(attempt: ReadAttempt) {
		return this.alive && this.state.allowed && this.state.foreground && this.request === attempt;
	}

	async start() {
		if (!this.alive || !this.state.foreground || this.reason) return;
		const displayIdentity = this.state.displayed?.displayIdentity;
		if (!displayIdentity) return;
		const attempt = (this.request = new ReadAttempt(DOWNLOAD_ACQUISITION_TIMEOUT_MS));
		this.error = null;
		try {
			const acquire = async () => {
				const response = await fetch(`/api/buyer/${this.token}/download`, {
					method: 'POST',
					cache: 'no-store',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ displayIdentity }),
					signal: attempt.signal
				});
				if (!response.ok) throw new Error('Download unavailable');
				const filename = response.headers
					.get('Content-Disposition')
					?.match(/filename\*=UTF-8''([^;]+)/iu)?.[1];
				if (!filename) throw new Error('Download filename unavailable');
				return { blob: await response.blob(), filename: decodeURIComponent(filename) };
			};
			const { blob, filename } = await waitForRead(acquire(), attempt.signal);
			if (
				this.owns(attempt) &&
				!attempt.signal.aborted &&
				this.state.connected &&
				this.state.displayed?.displayIdentity === displayIdentity
			)
				downloadWord(blob, filename);
		} catch {
			if (this.owns(attempt))
				this.error =
					'We couldn’t download the displayed contract. Check your connection and try again.';
		} finally {
			attempt.complete();
			if (this.request === attempt) this.request = undefined;
		}
	}

	reset() {
		const request = this.request;
		this.request = undefined;
		this.error = null;
		request?.abort();
	}

	destroy() {
		this.alive = false;
		this.reset();
	}
}
