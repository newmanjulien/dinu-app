import { getContext, setContext } from 'svelte';

export type PresentationOutcome = 'pending' | 'success' | 'error';
type Surface = { active: boolean; outcome: PresentationOutcome; revision: unknown };
export type PresentationTicket = {
	identity: string;
	owner: symbol;
	outcome: PresentationOutcome;
	revision: unknown;
	read: () => Surface;
};

const key = Symbol('workspace-presentation');

/** Only the visible primary surface can admit new optional work. */
class WorkspacePresentation {
	current = $state.raw<PresentationTicket>();
	painted = $state.raw<PresentationTicket>();
	revision = $state(0);

	constructor(
		readonly identity: () => string,
		readonly navigating: () => boolean
	) {}

	report(owner: symbol, read: () => Surface) {
		const surface = read();
		if (!surface.active) return;
		const identity = this.identity();
		const current = this.current;
		if (
			current?.identity === identity &&
			current.owner === owner &&
			current.outcome === surface.outcome &&
			current.revision === surface.revision
		)
			return;
		this.current = { identity, owner, read, outcome: surface.outcome, revision: surface.revision };
		this.painted = undefined;
	}

	isCurrent(ticket: PresentationTicket | undefined): ticket is PresentationTicket {
		if (!ticket || ticket !== this.current || ticket.identity !== this.identity()) return false;
		// Read the owner's actual state too: an import can finish before its reporting effect runs.
		const surface = ticket.read();
		return (
			surface.active && surface.outcome === ticket.outcome && surface.revision === ticket.revision
		);
	}

	release(owner: symbol) {
		if (this.current?.owner !== owner) return;
		this.current = undefined;
		this.painted = undefined;
	}

	restart() {
		this.revision++;
		this.current = undefined;
		this.painted = undefined;
	}

	canStart() {
		return !this.navigating() && this.isCurrent(this.painted) && this.painted.outcome !== 'pending';
	}
}

export const setWorkspacePresentation = (identity: () => string, navigating: () => boolean) =>
	setContext(key, new WorkspacePresentation(identity, navigating));
export const useWorkspacePresentation = () => getContext<WorkspacePresentation | undefined>(key);
