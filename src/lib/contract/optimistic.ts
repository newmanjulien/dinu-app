import type { OptimisticLocalStore } from 'convex/browser';
import type { FunctionArgs } from 'convex/server';
import { api } from '../../convex/_generated/api';

export function optimisticRename(
	store: OptimisticLocalStore,
	args: FunctionArgs<typeof api.contracts.rename>
) {
	const title = args.title.trim();
	const stateArgs = { id: args.id };
	const state = store.getQuery(api.contracts.state, stateArgs);
	if (state) store.setQuery(api.contracts.state, stateArgs, { ...state, title });
	const home = store.getQuery(api.contracts.home, {});
	if (home)
		store.setQuery(
			api.contracts.home,
			{},
			{
				...home,
				page: home.page.map((row) => (row._id === args.id ? { ...row, title } : row))
			}
		);
}

export function optimisticRemove(
	store: OptimisticLocalStore,
	args: FunctionArgs<typeof api.contracts.remove>
) {
	const stateArgs = { id: args.id };
	if (store.getQuery(api.contracts.state, stateArgs) !== undefined)
		store.setQuery(api.contracts.state, stateArgs, null);
	const home = store.getQuery(api.contracts.home, {});
	if (home)
		store.setQuery(
			api.contracts.home,
			{},
			{
				...home,
				page: home.page.filter((row) => row._id !== args.id)
			}
		);
}
