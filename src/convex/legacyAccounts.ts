/** Temporary v1 account views for existing browser tabs. New code uses accounts. */
import { paginationResultValidator } from 'convex/server';
import { v, type Infer } from 'convex/values';
import { api } from './_generated/api';
import { query } from './_generated/server';
import { readViewer } from './accounts';
import { accountView, profileView } from './accountViews';
import { legacyCard } from './legacyViews';
import { role } from './permissions';

const legacyViewer = v.union(
	v.null(),
	accountView.extend({ profile: profileView.extend({ role }) })
);
function project(viewer: Awaited<ReturnType<typeof readViewer>>): Infer<typeof legacyViewer> {
	return viewer
		? { ...viewer, profile: { ...viewer.profile, role: viewer.membership?.role ?? 'rep' } }
		: null;
}
export const viewer = query({
	args: {},
	returns: legacyViewer,
	handler: async (ctx): Promise<Infer<typeof legacyViewer>> => project(await readViewer(ctx))
});
const startupResult = v.object({
	viewer: legacyViewer,
	contracts: v.union(paginationResultValidator(legacyCard), v.null())
});
export const startup = query({
	args: {},
	returns: startupResult,
	handler: async (ctx): Promise<Infer<typeof startupResult>> => {
		const result = await ctx.runQuery(api.accounts.startup, {});
		return {
			viewer: project(result.viewer),
			contracts: result.contracts
				? {
						...result.contracts,
						page: result.contracts.page.map(({ buyerCompanyName, ...card }) => ({
							...card,
							companyName: buyerCompanyName
						}))
					}
				: null
		};
	}
});
