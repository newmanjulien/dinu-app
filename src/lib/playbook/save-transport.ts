import type { ConvexClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { type PlaybookItem, type PlaybookItemRecord } from './model';
import type { AuthoringWatermark, DetailRecord } from './structure';

export type SaveRequest = {
	id?: PlaybookItemRecord['_id'];
	item: PlaybookItem;
	expectedContentRevision: number;
	operationId: string;
};
export type Operation =
	| { kind: 'save'; request: SaveRequest }
	| { kind: 'delete'; id: PlaybookItemRecord['_id']; expectedContentRevision: number };
export type SaveResult =
	| ({ status: 'saved'; item: DetailRecord } & AuthoringWatermark)
	| ({ status: 'conflict'; item: PlaybookItemRecord } & AuthoringWatermark)
	| ({ status: 'deleted' } & AuthoringWatermark)
	| { status: 'missing' }
	| { status: 'rejected'; message: string };
export type SaveTransport = (operation: Operation) => Promise<SaveResult>;
export const convexSaveTransport =
	(client: ConvexClient, membershipId: Id<'memberships'>): SaveTransport =>
	async (operation) => {
		try {
			const result = await (operation.kind === 'save'
				? client.mutation(api.playbookItems.savePlaybookItem, {
						...operation.request,
						membershipId
					})
				: client.mutation(api.playbookItems.deletePlaybookItem, {
						membershipId,
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
