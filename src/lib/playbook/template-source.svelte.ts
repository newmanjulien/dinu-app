import { createReadQuery } from '$lib/auth/read-query.svelte';
import type { SnapshotClient } from '$lib/query-once';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';

/** One membership's prose subscription, shared by both audience sessions. */
export class TemplateSource {
	private readers = $state(0);
	private available = $state(true);
	private generation = $state(0);
	readonly read: ReturnType<typeof createReadQuery<typeof api.templateSources.authoringSource>>;
	private releaseEffects: () => void;
	constructor(client: SnapshotClient, membershipId: Id<'memberships'>) {
		let read!: TemplateSource['read'];
		this.releaseEffects = $effect.root(() => {
			const active = $derived(this.available && this.readers > 0);
			read = createReadQuery(
				client,
				api.templateSources.authoringSource,
				() => (active ? { membershipId } : 'skip'),
				() => this.generation
			);
		});
		this.read = read;
	}
	configure(available: boolean, generation: number) {
		this.available = available;
		this.generation = generation;
	}
	retain() {
		this.readers++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.readers--;
		};
	}
	destroy() {
		this.releaseEffects();
	}
}
