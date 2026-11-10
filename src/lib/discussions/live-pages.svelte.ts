import { ReadAttempt } from '../auth/attempt';
export const discussionPage = (cursor: string | null = null) => ({
	numItems: 20,
	cursor,
	maximumRowsRead: 30,
	maximumBytesRead: 1_500_000
});
type PageResult<Row> = { page: Row[]; isDone: boolean; continueCursor: string };
type Page<Row> = {
	cursor: string | null;
	rows: Row[];
	next: string | null;
	done: boolean;
	state: 'pending' | 'accepted' | 'failed';
	stop?: () => void;
	attempt: ReadAttempt;
};
/** Live bounded pages retain accepted rows through timeouts; access refusals revoke every row. */
export class LiveDiscussionPages<Row extends { id: string }> {
	rows = $state.raw<Row[]>([]);
	error = $state.raw<Error | null>(null);
	loading = $state(false);
	authorized = $state(true);
	done = $state(false);
	private pages: Page<Row>[] = [];
	private generation = 0;
	private active = false;
	constructor(
		private subscribe: (
			opts: ReturnType<typeof discussionPage>,
			receive: (value: PageResult<Row>) => void,
			fail: (error: Error) => void
		) => () => void,
		private changed: () => void = () => {}
	) {}
	reset() {
		this.stop();
		this.active = true;
		this.authorized = true;
		this.done = false;
		this.error = null;
		this.loadMore();
	}
	loadMore() {
		if (!this.active || this.loading || this.done || !this.authorized) return;
		const tail = this.pages.at(-1);
		if (tail?.state === 'pending') return;
		const cursor = tail?.state === 'failed' ? tail.cursor : (tail?.next ?? null);
		if (tail?.state === 'failed') this.pages.pop();
		this.loading = true;
		this.error = null;
		const generation = this.generation,
			attempt = new ReadAttempt(15_000),
			page: Page<Row> = {
				cursor,
				state: 'pending',
				rows: [],
				next: null,
				done: false,
				attempt
			};
		this.pages.push(page);
		const current = () => this.active && this.generation === generation && !attempt.signal.aborted;
		attempt.signal.addEventListener(
			'abort',
			() => {
				if (!this.active || this.generation !== generation) return;
				page.stop?.();
				page.state = 'failed';
				this.loading = false;
				this.error = new Error('Discussion request timed out. Try again.');
			},
			{ once: true }
		);
		page.stop = this.subscribe(
			discussionPage(page.cursor),
			(value) => {
				if (!current()) return;
				attempt.complete();
				page.state = 'accepted';
				page.rows = value.page;
				page.next = value.continueCursor;
				page.done = value.isDone;
				this.rows = [
					...new Map(this.pages.flatMap((p) => p.rows).map((row) => [row.id, row])).values()
				];
				this.loading = this.pages.some((p) => p.state === 'pending');
				this.done = this.pages.at(-1)?.done ?? false;
				this.changed();
			},
			(error) => {
				if (!current()) return;
				this.stop();
				this.rows = [];
				this.done = false;
				this.authorized = false;
				this.changed();
				this.error = error;
			}
		);
		if (!current()) page.stop();
	}
	refuse(error: Error) {
		this.stop();
		this.rows = [];
		this.done = false;
		this.authorized = false;
		this.error = error;
		this.changed();
	}
	retry() {
		if (!this.authorized || !this.active) {
			this.reset();
			return;
		}
		if (this.error) {
			this.loadMore();
			return;
		}
		this.reset();
	}
	stop() {
		this.active = false;
		this.generation++;
		for (const page of this.pages) {
			page.stop?.();
			page.attempt.abort();
		}
		this.pages = [];
		this.loading = false;
	}
	destroy() {
		this.stop();
		this.rows = [];
	}
}
