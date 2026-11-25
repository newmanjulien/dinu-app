import type { Id } from '../../convex/_generated/dataModel';

type DeleteConfirmation = {
	messageId: Id<'discussionMessages'>;
	revision: number;
	token: number;
	operationId: string;
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
		this.current = {
			messageId,
			revision,
			token,
			operationId: crypto.randomUUID(),
			busy: false,
			abandoned: false,
			error: null
		};
		return token;
	}

	start(token: number) {
		if (this.current?.token !== token || this.current.busy) return false;
		this.current = { ...this.current, busy: true, error: null };
		return true;
	}

	restore(token: number) {
		if (this.current?.token !== token) return;
		this.current = this.current.abandoned ? null : { ...this.current, busy: false };
	}

	finish(token: number, error?: string, rotateOperationId = false) {
		if (this.current?.token !== token) return;
		this.current =
			error && !this.current.abandoned
				? {
						...this.current,
						busy: false,
						error,
						...(rotateOperationId ? { operationId: crypto.randomUUID() } : {})
					}
				: null;
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

	clear() {
		this.current = null;
	}
}
