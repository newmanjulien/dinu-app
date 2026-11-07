import type { Viewer, useViewerSession } from '../../src/lib/auth/viewer-session.svelte';
type MutableSession = {
	-readonly [Key in keyof ReturnType<typeof useViewerSession>]: ReturnType<
		typeof useViewerSession
	>[Key];
};
export function csmState() {
	const state = $state({
		viewer: {
			profile: {
				id: 'profile',
				name: 'Synthetic',
				email: 'synthetic@example.com',
				avatarUrl: null
			},
			membership: { id: 'member', companyId: 'company', role: 'admin', isOwner: true },
			company: { id: 'company', name: 'Synthetic', csmCallBooked: false, deletionPending: false },
			permissions: { manageTemplate: true },
			templateReady: true
		} as Viewer,
		session: {
			preparedSessionId: 'session',
			userId: 'user',
			phase: 'ready',
			blocked: false,
			closing: false,
			transportGeneration: 0
		} as MutableSession,
		revision: 0,
		form: false,
		outcome: 'success' as 'success' | 'pending' | 'error'
	});
	return state;
}
export type CsmState = ReturnType<typeof csmState>;
