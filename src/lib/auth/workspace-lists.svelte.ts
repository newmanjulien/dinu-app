import { getContext, setContext } from 'svelte';
import { usePaginatedQuery } from 'convex-svelte';
import { api } from '../../convex/_generated/api';
import { useReadQuery } from './read-query.svelte';
import { useViewer, useViewerSession } from './viewer-session.svelte';

/** The workspace owns live lists; routes never copy rows into a display cache. */
export function createWorkspaceLists() {
	const viewer = useViewer();
	const session = useViewerSession();
	let teamOpened = $state(false);
	let colleaguesRevision = $state(0);
	let invitationsRevision = $state(0);
	const available = () =>
		session.workspaceAdmitted && !session.blocked && !session.closing && !viewer().company.deletion;
	const home = useReadQuery(
		api.contracts.home,
		() => (available() ? {} : 'skip'),
		() => session.transportGeneration
	);
	const colleagues = usePaginatedQuery(
		api.profiles.colleagues,
		() => {
			void colleaguesRevision;
			void session.transportGeneration;
			return available() && teamOpened ? {} : 'skip';
		},
		{ initialNumItems: 50 }
	);
	const invitations = usePaginatedQuery(
		api.companyInvitations.list,
		() => {
			void invitationsRevision;
			void session.transportGeneration;
			return available() && teamOpened && viewer().permissions.manageMembers ? {} : 'skip';
		},
		{ initialNumItems: 50 }
	);
	return {
		home,
		colleagues,
		invitations,
		openTeam: () => {
			teamOpened = true;
		},
		retryColleagues: () => {
			colleaguesRevision++;
		},
		retryInvitations: () => {
			invitationsRevision++;
		}
	};
}
export type WorkspaceLists = ReturnType<typeof createWorkspaceLists>;
const key = Symbol('workspace-lists');
export const setWorkspaceLists = (lists: WorkspaceLists) => setContext(key, lists);
export const useWorkspaceLists = () => getContext<WorkspaceLists>(key);
