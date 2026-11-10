import type { GenericDatabaseWriter, GenericDataModel } from 'convex/server';
import { ConvexError, v, type GenericId, type Value } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import schema from './schema';
import { validate } from 'convex-helpers/validators';
import { documentBytes } from './storageCapacity';
import { readTemplateSource } from './templateSourceStorage';
import { templateReadCapacity } from './templates';
import { terminologyTransition } from './terminologyMaintenance';

type Database = GenericDatabaseWriter<GenericDataModel>;
type Row = Record<string, Value> & { _id: GenericId<string>; _creationTime: number };
const phases = [
	'baselines',
	'baselineChunks',
	'baselineValidationChunks',
	'baselineAuthoring',
	'templateVersions',
	'authoringMigrations',
	'company',
	'companyDeletions',
	'verifySources',
	'verifyCertificates',
	'verifyVersions',
	'deleteCertificates',
	'deleteValidation',
	'deleteBlocks',
	'deleteSources',
	'deleteMappings'
] as const;
function recordId<Table extends string>(db: Database, table: Table, value: Value) {
	const id = typeof value === 'string' && db.normalizeId(table, value);
	if (!id) throw new ConvexError(`Invalid ${table} record identity.`);
	return id;
}
const progress = v.object({ phase: v.string(), done: v.boolean() });
function fields(row: Row) {
	const { _id, _creationTime, ...value } = row;
	return value;
}
async function mapping(db: Database, id: string) {
	const row = await db
		.query('terminologyMappings')
		.withIndex('by_legacyId', (q) => q.eq('legacyId', id))
		.unique();
	if (!row)
		throw new ConvexError('Missing terminology mapping. Migration stopped without advancing.');
	return row;
}
async function sourceFor(db: Database, row: Row) {
	if (typeof row.baselineId !== 'string') throw new ConvexError('Missing legacy source reference.');
	const map = await mapping(db, row.baselineId);
	if (map.companyId !== row.companyId) throw new ConvexError('Template source ownership mismatch.');
	const id = recordId(db, 'templateSources', map.newId);
	const source = await db.get('templateSources', id);
	if (!source || source.companyId !== row.companyId)
		throw new ConvexError('Missing migrated template source.');
	return { map, source, sourceId: id };
}
function validateRow(
	db: Database,
	table: keyof typeof schema.tables,
	value: Record<string, Value>
) {
	if (!validate(schema.tables[table].validator, value, { db }))
		throw new ConvexError(`Invalid migrated ${table} record. Migration stopped without advancing.`);
	documentBytes(value);
}
async function copy(
	db: Database,
	row: Row,
	table: keyof typeof schema.tables,
	value: Record<string, Value>,
	oldReadBytes?: number
) {
	validateRow(db, table, value);
	const id = await db.insert(table, value);
	const saved = await db.get(table, id);
	if (!saved) throw new ConvexError('Migrated record was not stored.');
	const readBytes = documentBytes(saved);
	await db.insert('terminologyMappings', {
		legacyId: row._id,
		newId: id,
		companyId: row.companyId,
		readBytes,
		...(oldReadBytes === undefined ? {} : { oldReadBytes })
	});
	return readBytes;
}
async function convert(db: Database, ctx: MutationCtx, phase: (typeof phases)[number], row: Row) {
	if (phase === 'baselines') {
		if (typeof row.chunkReadBytes !== 'number')
			throw new ConvexError('Source accounting is missing.');
		await copy(
			db,
			row,
			'templateSources',
			{ ...fields(row), chunkReadBytes: 0 },
			row.chunkReadBytes
		);
	} else if (phase === 'baselineChunks' || phase === 'baselineValidationChunks') {
		const { source, sourceId } = await sourceFor(db, row);
		const { baselineId, ...value } = fields(row);
		const bytes = await copy(
			db,
			row,
			phase === 'baselineChunks' ? 'templateSourceChunks' : 'templateSourceValidationChunks',
			{ ...value, templateSourceId: sourceId }
		);
		if (phase === 'baselineChunks')
			await db.patch('templateSources', sourceId, {
				chunkReadBytes: Number(source.chunkReadBytes) + bytes
			});
	} else if (phase === 'baselineAuthoring') {
		const { source, sourceId } = await sourceFor(db, row);
		if (source.state === 'deleting') return;
		if (!Array.isArray(row.chunkIds)) throw new ConvexError('Certificate chunk list is missing.');
		const chunkIds = [];
		let readBytes = 0;
		for (const oldId of row.chunkIds) {
			const map = await mapping(db, String(oldId));
			if (map.companyId !== row.companyId || typeof map.readBytes !== 'number')
				throw new ConvexError('Invalid certificate chunk mapping.');
			chunkIds.push(String(map.newId));
			readBytes += map.readBytes;
		}
		const { baselineId, ...value } = fields(row);
		await copy(db, row, 'templateSourceCertificates', {
			...value,
			templateSourceId: sourceId,
			chunkIds,
			readBytes
		});
	} else if (
		phase === 'templateVersions' ||
		phase === 'authoringMigrations' ||
		phase === 'company'
	) {
		if (!('baselineId' in row)) {
			validateRow(db, phase, fields(row));
			return;
		}
		const { map, source, sourceId } = await sourceFor(db, {
			...row,
			companyId: phase === 'company' ? row._id : row.companyId
		});
		const { baselineId, ...value } = fields(row);
		value.templateSourceId = sourceId;
		if (phase === 'templateVersions') {
			if (typeof value.contentReadBytes !== 'number' || typeof map.oldReadBytes !== 'number')
				throw new ConvexError('Template version accounting is missing.');
			value.contentReadBytes += Number(source.chunkReadBytes) - map.oldReadBytes;
		}
		validateRow(db, phase, value);
		await db.replace(phase, recordId(db, phase, row._id), value);
	} else if (phase === 'companyDeletions') {
		const value = fields(row);
		if (value.phase === 'baselines') value.phase = 'templateSources';
		validateRow(db, phase, value);
		await db.replace(phase, recordId(db, phase, row._id), value);
	} else if (phase === 'verifySources') {
		const id = ctx.db.normalizeId('templateSources', row._id)!;
		const source = await ctx.db.get('templateSources', id);
		if (!source) throw new ConvexError('Template source is missing.');
		if (source.state !== 'deleting') await readTemplateSource(ctx, id, source.companyId, source);
	} else if (phase === 'verifyCertificates') {
		validateRow(db, 'templateSourceCertificates', fields(row));
		const sourceId = db.normalizeId('templateSources', String(row.templateSourceId));
		const source = sourceId && (await db.get('templateSources', sourceId));
		if (!source || source.companyId !== row.companyId)
			throw new ConvexError('Certificate source is missing.');
		// Partially drained uploads may have incomplete certificates by design.
		if (source.state === 'deleting') return;
		if (!Array.isArray(row.chunkIds) || row.chunkIds.length !== row.chunkCount)
			throw new ConvexError('Certificate chunk count is incomplete.');
		let readBytes = 0,
			dataBytes = 0;
		for (const [order, id] of row.chunkIds.entries()) {
			const chunkId = db.normalizeId('templateSourceValidationChunks', String(id));
			const chunk = chunkId && (await db.get('templateSourceValidationChunks', chunkId));
			if (
				!chunk ||
				chunk.companyId !== row.companyId ||
				chunk.templateSourceId !== source._id ||
				chunk.order !== order ||
				!(chunk.data instanceof ArrayBuffer)
			)
				throw new ConvexError('Certificate chunk reference is incomplete.');
			readBytes += documentBytes(chunk);
			dataBytes += chunk.data.byteLength;
		}
		if (readBytes !== row.readBytes || dataBytes !== row.dataBytes)
			throw new ConvexError('Certificate byte accounting changed.');
	} else if (phase === 'verifyVersions') {
		validateRow(db, 'templateVersions', fields(row));
		const sourceId = ctx.db.normalizeId('templateSources', String(row.templateSourceId));
		const source = sourceId && (await ctx.db.get('templateSources', sourceId));
		if (!source || source.companyId !== row.companyId)
			throw new ConvexError('A historical template version has lost its source.');
		const version = await ctx.db.get(
			'templateVersions',
			ctx.db.normalizeId('templateVersions', row._id)!
		);
		if (!version) throw new ConvexError('Historical template metadata is missing.');
		templateReadCapacity(version, source);
	}
}

/** One native row per transaction. State and writes commit together; rerun to resume. */
export const step = internalMutation({
	args: {},
	returns: progress,
	handler: async (ctx) => {
		if (!terminologyTransition || schema.schemaValidation)
			throw new ConvexError(
				'Prepare and deploy the reviewed terminology maintenance schema first.'
			);
		const db: Database = ctx.db;
		const stored = await db
			.query('terminologyMigrationState')
			.withIndex('by_name', (q) => q.eq('name', 'template-terminology'))
			.unique();
		if (!stored) {
			const cleaning = await ctx.db
				.query('companyDeletions')
				.withIndex('by_status_and_requestedAt', (q) => q.eq('status', 'cleaning'))
				.first();
			if (cleaning)
				throw new ConvexError(
					`Company deletion ${cleaning._id} is still cleaning (phase: ${cleaning.phase}). No terminology migration writes were made. Restore the exact legacy bundle, let company cleanup finish, then redeploy maintenance and retry.`
				);
		}
		const state = stored ?? {
			_id: await db.insert('terminologyMigrationState', {
				name: 'template-terminology',
				phase: 0,
				cursor: null
			}),
			phase: 0,
			cursor: null
		};
		const phase = phases[Number(state.phase)];
		if (!phase) throw new ConvexError('Invalid migration phase.');
		const deleting = phase.startsWith('delete');
		const table =
			(
				{
					verifySources: 'templateSources',
					verifyCertificates: 'templateSourceCertificates',
					verifyVersions: 'templateVersions',
					deleteCertificates: 'baselineAuthoring',
					deleteValidation: 'baselineValidationChunks',
					deleteBlocks: 'baselineChunks',
					deleteSources: 'baselines',
					deleteMappings: 'terminologyMappings'
				} as Record<string, string>
			)[phase] ?? phase;
		const page = await db
			.query(table)
			.paginate({ numItems: 1, cursor: deleting ? null : (state.cursor as string | null) });
		for (const row of page.page) {
			const id = recordId(db, table, row._id);
			if (deleting) await db.delete(table, id);
			else {
				if (typeof row._creationTime !== 'number')
					throw new ConvexError('Missing record creation time.');
				await convert(db, ctx, phase, { ...row, _id: id, _creationTime: row._creationTime });
			}
		}
		// Deletion always resumes at the first remaining row, avoiding mutation-sensitive cursors.
		const finishedPhase = deleting ? page.page.length === 0 : page.isDone;
		const next = Number(state.phase) + (finishedPhase ? 1 : 0);
		if (next === phases.length) {
			await db.delete(
				'terminologyMigrationState',
				recordId(db, 'terminologyMigrationState', state._id)
			);
			return { phase: 'complete', done: true };
		}
		await db.patch(
			'terminologyMigrationState',
			recordId(db, 'terminologyMigrationState', state._id),
			{
				phase: next,
				cursor: finishedPhase || deleting ? null : page.continueCursor
			}
		);
		return { phase: phases[next], done: false };
	}
});
