import { contractName } from '$lib/contract/filename';
import { downloadWord } from '$lib/document/export/download';

type DownloadState = {
	readonly allowed: boolean;
	readonly foreground: boolean;
	readonly connected: boolean;
	readonly content?: { title: string; buyerRevision: number };
	readonly displayed?: { title: string; buyerRevision: number };
};

/** The server download belongs to the attached route, independently of its viewer. */
export class BuyerDownload {
	error = $state<string | null>(null);
	private request = $state.raw<AbortController>();
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
				: !this.state.allowed ||
					  !this.state.displayed ||
					  this.state.displayed.buyerRevision !== this.state.content?.buyerRevision
					? 'Downloading is unavailable for this version. You can still review the contract.'
					: null;
	}

	private owns(controller: AbortController) {
		return (
			this.alive &&
			this.state.allowed &&
			this.state.foreground &&
			this.request === controller &&
			!controller.signal.aborted
		);
	}

	async start() {
		if (!this.alive || !this.state.foreground || this.reason) return;
		const controller = (this.request = new AbortController());
		this.error = null;
		const displayed = this.state.displayed!;
		try {
			const response = await fetch(`/api/buyer/${this.token}/download`, {
				method: 'POST',
				cache: 'no-store',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ buyerRevision: displayed.buyerRevision }),
				signal: controller.signal
			});
			if (!response.ok) throw new Error('Download unavailable');
			const blob = await response.blob();
			if (
				this.owns(controller) &&
				this.state.connected &&
				this.state.displayed === displayed &&
				this.state.content?.buyerRevision === displayed.buyerRevision
			)
				downloadWord(blob, `${contractName(displayed.title)}.docx`);
		} catch {
			if (this.owns(controller))
				this.error =
					'We couldn’t download this version. Check your connection or open the latest link, then try again.';
		} finally {
			if (this.request === controller) this.request = undefined;
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
