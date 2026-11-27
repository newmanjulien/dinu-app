import type { ConvexClient } from 'convex/browser';
import type { FunctionReference, FunctionReturnType } from 'convex/server';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

/** Register stable route keys while expectAuth queues the initial authenticated frame. */
export function registerStartupRouteReads(
	client: ConvexClient,
	path: string,
	versionId?: Id<'templateVersions'>
) {
	const releases: (() => void)[] = [];
	const ignore = () => {};
	if (path === '/contracts') releases.push(client.onUpdate(api.contracts.home, {}, ignore, ignore));
	else if (/^\/contracts\/[^/]+$/.test(path) && path !== '/contracts/new') {
		const id = decodeURIComponent(path.slice('/contracts/'.length));
		releases.push(client.onUpdate(api.contracts.state, { id }, ignore, ignore));
		if (versionId)
			releases.push(client.onUpdate(api.templates.frozenContent, { versionId }, ignore, ignore));
	} else if (path === '/template')
		releases.push(
			client.onUpdate(api.playbookItems.currentStructure, { audience: 'rep' }, ignore, ignore)
		);
	else if (path === '/team')
		releases.push(
			client.onPaginatedUpdate_experimental(
				// The SDK supplies paginationOpts; its experimental signature still requires it.
				api.profiles.colleagues as FunctionReference<
					'query',
					'public',
					{},
					FunctionReturnType<typeof api.profiles.colleagues>
				>,
				{},
				{ initialNumItems: 50 },
				ignore,
				ignore
			).unsubscribe
		);
	return () => {
		for (const release of releases) release();
	};
}
