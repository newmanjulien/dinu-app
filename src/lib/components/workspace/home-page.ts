import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../../convex/_generated/api';
import type { StartupHome } from '$lib/auth/startup-data';
import type { Viewer } from '$lib/auth/viewer-session.svelte';
import type { WorkspaceLists } from '$lib/auth/workspace-lists.svelte';

export type HomePageRows = FunctionReturnType<typeof api.contracts.home>['page'];

/** SSR seeds only the first live observation, and never certifies an empty search. */
export function homePage(
	home: WorkspaceLists['home'],
	startup: StartupHome | null,
	viewer: Viewer,
	userId: string | null
) {
	if (home.data !== undefined) return home.data;
	if (
		home.rejected ||
		!startup ||
		startup.userId !== userId ||
		startup.scope.profileId !== viewer.profile.id ||
		startup.scope.membershipId !== viewer.membership.id ||
		startup.scope.companyId !== viewer.company.id ||
		startup.search !== '' ||
		startup.cursor !== null ||
		startup.numItems !== 24
	)
		return;
	return startup.contracts;
}
export function matchingHomeRows(rows: HomePageRows, query: string): HomePageRows {
	const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
	return words.length
		? rows.filter((row) => words.every((word) => row.title.toLocaleLowerCase().includes(word)))
		: rows;
}
