import type { Id } from '../../convex/_generated/dataModel';

type DeleteConfirmation = {
	messageId: Id<'discussionMessages'>;
	revision: number;
	token: number;
	busy: boolean;
	abandoned: boolean;
	error: string | null;
};

export class DeleteConfirmationState {
	current = $state<DeleteConfirmation | null>(null);
	private nextToken = 0;

	open(messageId: Id<'discussionMessages'>, revision: number) {
		if (this.current?.busy) return null;
		const token = ++this.nextToken;
		this.current = { messageId, revision, token, busy: false, abandoned: false, error: null };
		return token;
	}

	start(token: number) {
		if (this.current?.token !== token || this.current.busy) return false;
		this.current = { ...this.current, busy: true, error: null };
		return true;
	}

	finish(token: number, error?: string) {
		if (this.current?.token !== token) return;
		this.current =
			error && !this.current.abandoned ? { ...this.current, busy: false, error } : null;
	}

	cancel(token: number) {
		if (this.current?.token !== token || this.current.busy) return false;
		this.current = null;
		return true;
	}

	clearMessage(messageId: Id<'discussionMessages'>) {
		if (this.current?.messageId !== messageId) return;
		this.current = this.current.busy ? { ...this.current, abandoned: true } : null;
	}
}
