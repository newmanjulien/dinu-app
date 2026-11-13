import type { ConvexClient, PaginationStatus } from 'convex/browser';
import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server';

type PageRow<Query extends FunctionReference<'query'>> =
	FunctionReturnType<Query> extends {
		page: (infer Row)[];
	}
		? Row
		: never;
export type NativePage<Row> = {
	results: Row[];
	status: PaginationStatus;
	loadMore: (count: number) => boolean;
};
export type NativePageSubscription<Row> = {
	unsubscribe: () => void;
	getCurrentValue: () => NativePage<Row> | undefined;
};
type Subscribe = <Query extends FunctionReference<'query'>>(
	query: Query,
	args: Omit<FunctionArgs<Query>, 'paginationOpts'>,
	options: { initialNumItems: number },
	changed: () => void,
	failed: (error: Error) => void
) => NativePageSubscription<PageRow<Query>>;
/** Convex 1.46's experimental declaration includes paginationOpts and wraps page rows
 * twice. Its installed implementation supplies native paginationOpts and returns rows.
 * Keep that declaration correction here; the native engine still owns every cursor. */
export function subscribeNativePage<Query extends FunctionReference<'query'>>(
	client: Pick<ConvexClient, 'onPaginatedUpdate_experimental'>,
	query: Query,
	args: Omit<FunctionArgs<Query>, 'paginationOpts'>,
	initialNumItems: number,
	changed: () => void,
	failed: (error: Error) => void
) {
	const subscribe = client.onPaginatedUpdate_experimental.bind(client) as unknown as Subscribe;
	return subscribe(query, args, { initialNumItems }, changed, failed);
}
