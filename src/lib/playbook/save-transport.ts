import type { TemplateAudience, TemplateItemId } from './model';
import type { DeepReadonly } from '../immutable';
import { semanticTemplateItem } from './content';
import type { ConvexClient } from 'convex/browser';
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

export type SaveRequest = Omit<
	FunctionArgs<typeof api.playbookItems.saveTemplateItem>,
	'membershipId'
>;
export type Operation =
	| { kind: 'save'; request: SaveRequest }
	| { kind: 'delete'; id: TemplateItemId; expectedContentRevision: number };
export type SaveResult =
	| FunctionReturnType<typeof api.playbookItems.saveTemplateItem>
	| FunctionReturnType<typeof api.playbookItems.deleteTemplateItem>
	| { status: 'rejected'; message: string };
export type SaveTransport = (operation: DeepReadonly<Operation>) => Promise<SaveResult>;
export const convexSaveTransport =
	(
		client: Pick<ConvexClient, 'mutation'>,
		membershipId: Id<'memberships'>,
		audience: TemplateAudience = 'rep'
	): SaveTransport =>
	async (operation) => {
		try {
			const result = await (operation.kind === 'save'
				? client.mutation(api.playbookItems.saveTemplateItem, {
						...operation.request,
						item: semanticTemplateItem(operation.request.item),
						membershipId
					})
				: client.mutation(api.playbookItems.deleteTemplateItem, {
						membershipId,
						audience,
						id: operation.id,
						expectedContentRevision: operation.expectedContentRevision
					}));
			return result;
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
