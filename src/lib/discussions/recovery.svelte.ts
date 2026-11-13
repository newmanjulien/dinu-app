import { SvelteMap } from 'svelte/reactivity';
import type { Infer } from 'convex/values';
import type { DiscussionAnchor, discussionCommand } from './validators';
import type { Id } from '../../convex/_generated/dataModel';

export type ReplyDraft = { text: string; busy: boolean; error: string | null };
export type EditDraft = ReplyDraft & {
	initialized: boolean;
	expected: number;
	authorKey: string;
	account: boolean;
};
export type DiscussionOperation = {
	id: string;
	authorKey: string;
	buyer: boolean;
	readonly account: boolean;
	uncertain: boolean;
	readonly command: Infer<typeof discussionCommand>;
};

/** Recoverable work only; feeds, authentication, selection and DOM belong to each session. */
export class DiscussionDrafts {
	composer = $state.raw<{
		anchor: DiscussionAnchor;
		type: 'comment' | 'proposal';
		revision: number;
		contentIdentity: string;
	} | null>(null);
	text = $state('');
	submitting = $state(false);
	composeError = $state<string | null>(null);
	readonly operations = new SvelteMap<string, DiscussionOperation>();
	readonly created = new SvelteMap<string, Id<'discussionThreads'>>();
	readonly replies = new Map<string, ReplyDraft>();
	readonly edits = new Map<string, EditDraft>();
	get recoverable() {
		return Boolean(
			this.composer ||
			this.submitting ||
			this.operations.size ||
			this.created.size ||
			[...this.replies.values()].some((draft) => draft.text || draft.busy) ||
			[...this.edits.values()].some((draft) => draft.initialized || draft.busy)
		);
	}
	destroy() {
		this.operations.clear();
		this.created.clear();
		this.replies.clear();
		this.edits.clear();
	}
}

/** Owned by one buyer-link shell, partitioned by the original account. */
export class DiscussionRecovery {
	private scopes = new Map<string, DiscussionDrafts>();
	forScope(scope: string) {
		for (const [key, drafts] of this.scopes) {
			if (key !== scope && !drafts.recoverable) this.scopes.delete(key);
		}
		let drafts = this.scopes.get(scope);
		if (!drafts) this.scopes.set(scope, (drafts = new DiscussionDrafts()));
		return drafts;
	}
	destroy() {
		for (const drafts of this.scopes.values()) drafts.destroy();
		this.scopes.clear();
	}
}
