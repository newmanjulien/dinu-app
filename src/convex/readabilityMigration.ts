import type { GenericDatabaseWriter, GenericDataModel } from 'convex/server';
import { ConvexError, v, type GenericValidator, type Value } from 'convex/values';
import { legacyRow } from '../lib/contract/legacy-values';
import { MAX_STORAGE_DOCUMENT_BYTES } from '../lib/contract/storage-limits';
import { internalMutation, internalQuery } from './_generated/server';
import { baselineBlocks, canonicalFingerprint } from './baselineStorage';
import { historicalRevision } from './playbookItemRevisions';
import schema from './schema';
import { documentBytes } from './storageCapacity';
import { MAX_SNAPSHOT_BYTES } from './templateCapacity';

/** Administrative conversion only. The normal strict schema disables every entry point. */
function requireTransition() {
	if (schema.schemaValidation)
		throw new ConvexError(
			'Readability conversion requires the reviewed temporary transition schema.'
		);
}

/** Validate converted rows even while native schema admission is temporarily disabled. */
function matches(
	value: unknown,
	validator: GenericValidator,
	db: GenericDatabaseWriter<GenericDataModel>
): boolean {
	switch (validator.kind) {
		case 'any':
			return true;
		case 'null':
			return value === null;
		case 'float64':
			return typeof value === 'number';
		case 'int64':
		case 'commitTs':
			return typeof value === 'bigint';
		case 'boolean':
		case 'string':
			return typeof value === validator.kind;
		case 'bytes':
			return value instanceof ArrayBuffer;
		case 'literal':
			return value === validator.value;
		case 'id':
			return typeof value === 'string' && db.normalizeId(validator.tableName, value) !== null;
		case 'array':
			return Array.isArray(value) && value.every((entry) => matches(entry, validator.element, db));
		case 'union':
			return validator.members.some((member) => matches(value, member, db));
		case 'object': {
			if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
			const fields = value as Record<string, unknown>;
			return (
				Object.keys(fields).every((key) => key in validator.fields) &&
				Object.entries(validator.fields).every(
					([key, field]) =>
						(!(key in fields) && field.isOptional === 'optional') || matches(fields[key], field, db)
				)
			);
		}
		case 'record':
			return (
				!!value &&
				typeof value === 'object' &&
				!Array.isArray(value) &&
				Object.entries(value).every(
					([key, entry]) => matches(key, validator.key, db) && matches(entry, validator.value, db)
				)
			);
	}
}

export const conversionTables = [
	'baselines',
	'playbookItems',
	'playbookItemRevisions',
	'savedContracts',
	'contractDirectory',
	'concessionDecisions',
	'approvalRequests',
	'templateVersions',
	'emailDeliveries',
	'companyDeletions',
	'creationReceipts',
	'emailSnapshots'
] as const;

export const convertBatch = internalMutation({
	args: {
		companyId: v.id('company'),
		table: v.union(...conversionTables.map((table) => v.literal(table))),
		cursor: v.union(v.string(), v.null())
	},
	returns: v.object({ cursor: v.string(), done: v.boolean(), changed: v.number() }),
	handler: async (ctx, args) => {
		requireTransition();
		const db: GenericDatabaseWriter<GenericDataModel> = ctx.db;
		// One native document per transaction bounds even the largest supported row.
		const page = await db
			.query(args.table)
			.withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
			.paginate({ numItems: 1, cursor: args.cursor });
		let changed = 0;
		for (const original of page.page) {
			if (original.companyId !== args.companyId)
				throw new ConvexError('Conversion scope mismatch.');
			const originalId = db.normalizeId(args.table, String(original._id));
			if (!originalId) throw new ConvexError('Invalid source record identity.');
			const converted = legacyRow(args.table, original);
			const { _id, _creationTime, ...fields } = converted;
			const destination =
				args.table === 'creationReceipts'
					? 'playbookItemCreationReceipts'
					: args.table === 'emailSnapshots'
						? 'emailSelectionChunks'
						: args.table;
			if (!matches(fields, schema.tables[destination].validator, db))
				throw new ConvexError(`Converted ${destination} record is invalid.`);
			const values = fields as Record<string, Value>;
			documentBytes(values);
			if (destination !== args.table) {
				// Neither legacy table ID is referenced by another table or a scheduled argument.
				const existing =
					destination === 'playbookItemCreationReceipts'
						? await ctx.db
								.query('playbookItemCreationReceipts')
								.withIndex('by_operationId', (q) => q.eq('operationId', String(fields.operationId)))
								.unique()
						: await ctx.db
								.query('emailSelectionChunks')
								.withIndex('by_deliveryId_and_order', (q) =>
									q
										.eq(
											'deliveryId',
											ctx.db.normalizeId('emailDeliveries', String(fields.deliveryId))!
										)
										.eq('order', Number(fields.order))
								)
								.unique();
				if (existing) {
					const { _id: existingId, _creationTime: existingTime, ...stored } = existing;
					if (canonicalFingerprint(stored) !== canonicalFingerprint(fields))
						throw new ConvexError('Conflicting converted receipt or selection chunk.');
				} else await db.insert(destination, values);
				await db.delete(args.table, originalId);
				changed++;
			} else if (canonicalFingerprint(original) !== canonicalFingerprint(converted)) {
				await db.replace(destination, db.normalizeId(destination, String(original._id))!, values);
				changed++;
			}
		}
		return { cursor: page.continueCursor, done: page.isDone, changed };
	}
});

export const versions = internalQuery({
	args: { companyId: v.id('company'), cursor: v.union(v.string(), v.null()) },
	returns: v.object({
		ids: v.array(v.id('templateVersions')),
		cursor: v.string(),
		done: v.boolean()
	}),
	handler: async (ctx, args) => {
		requireTransition();
		const page = await ctx.db
			.query('templateVersions')
			.withIndex('by_companyId', (q) => q.eq('companyId', args.companyId))
			.paginate({ numItems: 16, cursor: args.cursor });
		return {
			ids: page.page.map((version) => version._id),
			cursor: page.continueCursor,
			done: page.isDone
		};
	}
});

/** Import receipts retain their meaning when the approved seed's wire shape changes. */
export const mapSeedKey = internalMutation({
	args: {
		companyId: v.id('company'),
		baselineId: v.id('baselines'),
		previous: v.string(),
		next: v.string()
	},
	returns: v.null(),
	handler: async (ctx, args) => {
		requireTransition();
		if (![args.previous, args.next].every((value) => /^[0-9a-f]{64}$/.test(value)))
			throw new ConvexError('Invalid approved seed fingerprint.');
		const baseline = await ctx.db.get('baselines', args.baselineId);
		if (!baseline || baseline.companyId !== args.companyId || baseline.source !== 'seed')
			throw new ConvexError('Conversion scope mismatch.');
		if (baseline.bootstrapKey === args.next) return null;
		if (baseline.bootstrapKey !== args.previous)
			throw new ConvexError('Seed receipt does not match the approved original input.');
		await ctx.db.patch('baselines', baseline._id, { bootstrapKey: args.next });
		return null;
	}
});

export const accountVersion = internalMutation({
	args: { companyId: v.id('company'), versionId: v.id('templateVersions') },
	returns: v.object({ done: v.boolean() }),
	handler: async (ctx, args) => {
		requireTransition();
		const db: GenericDatabaseWriter<GenericDataModel> = ctx.db;
		const version = await ctx.db.get('templateVersions', args.versionId);
		if (!version || version.companyId !== args.companyId)
			throw new ConvexError('Conversion scope mismatch.');
		const baseline = await ctx.db.get('baselines', version.baselineId);
		if (!baseline || baseline.companyId !== args.companyId)
			throw new ConvexError('Missing conversion baseline.');
		const identity = canonicalFingerprint({ items: version.items, baseline: baseline.fingerprint });
		const progress = await db
			.query('readabilityProgress')
			.withIndex('by_versionId', (q) => q.eq('versionId', version._id))
			.unique();
		if (!progress) {
			const blocks = await baselineBlocks(ctx, baseline._id, args.companyId);
			await db.insert('readabilityProgress', {
				companyId: args.companyId,
				versionId: version._id,
				identity,
				nextItem: 0,
				jsonBytes: new TextEncoder().encode(JSON.stringify({ blocks, items: [] })).byteLength,
				readBytes: baseline.chunkReadBytes
			});
			return { done: false };
		}
		const progressId = db.normalizeId('readabilityProgress', String(progress._id));
		if (!progressId) throw new ConvexError('Invalid conversion progress identity.');
		if (progress.companyId !== args.companyId || progress.identity !== identity)
			throw new ConvexError('Template changed during conversion.');
		let nextItem = Number(progress.nextItem),
			jsonBytes = Number(progress.jsonBytes),
			readBytes = Number(progress.readBytes);
		if (
			![nextItem, jsonBytes, readBytes].every(
				(value) => Number.isSafeInteger(value) && value >= 0
			) ||
			nextItem > version.items.length
		)
			throw new ConvexError('Invalid conversion progress.');
		const end = Math.min(nextItem + 8, version.items.length);
		while (nextItem < end) {
			const metrics = await ctx.meta.getTransactionMetrics();
			if (
				metrics.bytesRead.remaining < MAX_STORAGE_DOCUMENT_BYTES + 65_536 ||
				metrics.documentsRead.remaining < 2
			)
				break;
			const reference = version.items[nextItem];
			const revision = await ctx.db.get('playbookItemRevisions', reference.revisionId);
			if (
				!revision ||
				revision.companyId !== args.companyId ||
				revision.itemId !== reference.itemId
			)
				throw new ConvexError('Missing converted revision.');
			jsonBytes +=
				new TextEncoder().encode(JSON.stringify(historicalRevision(revision))).byteLength +
				(nextItem ? 1 : 0);
			readBytes += documentBytes(revision);
			nextItem++;
		}
		if (nextItem < version.items.length) {
			await db.patch('readabilityProgress', progressId, { nextItem, jsonBytes, readBytes });
			return { done: false };
		}
		if (
			jsonBytes > MAX_SNAPSHOT_BYTES ||
			readBytes + documentBytes(version) + documentBytes(baseline) + 65_536 > 16 * 1024 * 1024
		)
			throw new ConvexError('Converted template exceeds its existing capacity guarantee.');
		await ctx.db.patch('templateVersions', version._id, {
			snapshotBytes: jsonBytes,
			contentReadBytes: readBytes
		});
		await db.delete('readabilityProgress', progressId);
		return { done: true };
	}
});
