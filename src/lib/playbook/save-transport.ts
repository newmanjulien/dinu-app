import type { Id } from '../../convex/_generated/dataModel';
import type { ConvexClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import { api } from '../../convex/_generated/api';
import {
	normalizePlaybookItemRecord,
	type PlaybookItem,
	type PlaybookItemRecord
} from './model';

export type SaveRequest = {
	id?: PlaybookItemRecord['_id'];
	item: PlaybookItem;
	expectedRevision: number;
	operationId: string;
};
export type Operation =
	| { kind: 'save'; request: SaveRequest }
	| { kind: 'delete'; id: PlaybookItemRecord['_id']; expectedRevision: number };
export type SaveResult =
	| { status: 'saved' | 'conflict'; item: PlaybookItemRecord }
	| { status: 'deleted' | 'missing' }
	| { status: 'rejected'; message: string };
export type SaveTransport = (operation: Operation) => Promise<SaveResult>;
export const convexSaveTransport =
	(client: ConvexClient, membershipId: Id<'memberships'>): SaveTransport =>
	async (operation) => {
		try {
			const result = await (operation.kind === 'save'
				? client.mutation(api.admin.savePlaybookItem, { ...operation.request, membershipId })
				: client.mutation(api.admin.deletePlaybookItem, {
						membershipId,
						id: operation.id,
						expectedRevision: operation.expectedRevision
					}));
			if ('item' in result && result.item !== undefined)
				return {
					status: result.status as 'saved' | 'conflict',
					item: normalizePlaybookItemRecord(result.item)
				};
			if (result.status === 'rejected') return { status: 'rejected', message: result.message };
			return { status: result.status as 'deleted' | 'missing' };
		} catch (error) {
			if (
				error instanceof ConvexError &&
				typeof error.data === 'object' &&
				error.data !== null &&
				'code' in error.data &&
				error.data.code === 'TEMPLATE_PUBLICATION_REJECTED' &&
				'message' in error.data &&
				typeof error.data.message === 'string'
			)
				return { status: 'rejected', message: error.data.message };
			throw error;
		}
	};
