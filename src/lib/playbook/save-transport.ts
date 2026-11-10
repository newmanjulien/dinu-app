import { authoredItem, authoringRecord } from './authoring-item';
import type { InstructionAudience, PlaybookItem } from './model';
import type { DetailRecord } from './structure';
import type { DeepReadonly } from '../immutable';
import { semanticPlaybookDraft } from './content';
import type { ConvexClient } from 'convex/browser';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import type { PlaybookItemRecord } from './model';

export type SaveRequest = Omit<
	FunctionArgs<typeof api.playbookItems.savePlaybookItem>,
	'membershipId' | 'item'
> & { item: PlaybookItem };
export type Operation =
	| { kind: 'save'; request: SaveRequest }
	| { kind: 'delete'; id: PlaybookItemRecord['_id']; expectedContentRevision: number };
type RawResult =
	| FunctionReturnType<typeof api.playbookItems.savePlaybookItem>
	| FunctionReturnType<typeof api.playbookItems.deletePlaybookItem>
	| { status: 'rejected'; message: string };
type EditorResult<T> = T extends { item: unknown } ? Omit<T, 'item'> & { item: DetailRecord } : T;
export type SaveResult = EditorResult<RawResult>;
export type SaveTransport = (operation: DeepReadonly<Operation>) => Promise<SaveResult>;
export const convexSaveTransport =
	(
		client: Pick<ConvexClient, 'mutation'>,
		membershipId: Id<'memberships'>,
		audience: InstructionAudience = 'rep'
	): SaveTransport =>
	async (operation) => {
		try {
			const result = await (operation.kind === 'save'
				? client.mutation(api.playbookItems.savePlaybookItem, {
						...operation.request,
						item: authoredItem(semanticPlaybookDraft(operation.request.item), audience),
						membershipId
					})
				: client.mutation(api.playbookItems.deletePlaybookItem, {
						membershipId,
						audience,
						id: operation.id,
						expectedContentRevision: operation.expectedContentRevision
					}));
			return 'item' in result ? { ...result, item: authoringRecord(result.item) } : result;
		} catch (error) {
			if (error instanceof ConvexError && typeof error.data === 'string')
				return { status: 'rejected', message: error.data };
			if (
				error instanceof ConvexError &&
				typeof error.data === 'object' &&
				error.data !== null &&
				'code' in error.data &&
				error.data.code === 'TEMPLATE_SAVE_REJECTED' &&
				'message' in error.data &&
				typeof error.data.message === 'string'
			)
				return { status: 'rejected', message: error.data.message };
			throw error;
		}
	};
