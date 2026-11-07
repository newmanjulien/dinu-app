/** Source-only migration entry points. Operators run these after deploying the additive schema. */
import { ConvexError, v, getConvexSize } from 'convex/values';
import { validatePlaybook } from '../lib/playbook/audit';
import { itemStructure } from '../lib/playbook/structure';
import { VALIDATION_CODEC_VERSION } from '../lib/contract/validation-codec';
import type { Doc } from './_generated/dataModel';
import { internalMutation, type MutationCtx } from './_generated/server';
import { requireCompany } from './auth';
import {
	writeValidationFacts,
	validationCertified,
	readValidationCertificate
} from './authoringValidation';
import { canonicalFingerprint, readBaseline } from './baselineStorage';
import {
	businessItem,
	compactHead,
	headStructure,
	historicalRevision,
	liveRevision
} from './playbookItemRevisions';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import {
	currentPointer,
	versionReader,
	templateReadCapacity,
	versionReferences,
	orderedHeads,
	authoringReadCapacity
} from './templates';

const progress = v.object({
	state: v.union(
		v.literal('heads'),
		v.literal('versions'),
		v.literal('certify'),
		v.literal('complete')
	),
	nextItem: v.number(),
	itemCount: v.number()
});
const CAPTURE_CHANGED = 'The captured authoring migration changed. Restart certification.';
const unavailable = () => new ConvexError(CAPTURE_CHANGED);
async function captured(ctx: MutationCtx, companyId: Doc<'company'>['_id']) {
	const company = await requireCompany(ctx, companyId),
		migration = await ctx.db
			.query('authoringMigrations')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.unique();
	if (!migration) throw unavailable();
	const pointer = await currentPointer(ctx, companyId),
		version = await ctx.db.get('templateVersions', migration.versionId),
		baseline = await ctx.db.get('baselines', migration.baselineId);
	if (
		(migration.state !== 'complete' && !company.authoringMigration) ||
		!pointer ||
		!version ||
		!baseline ||
		(migration.state !== 'complete' && pointer.versionId !== version._id) ||
		version.companyId !== companyId ||
		baseline.companyId !== companyId ||
		company.baselineId !== baseline._id ||
		version.baselineId !== baseline._id ||
		(migration.state !== 'complete' && baseline.fingerprint !== migration.fingerprint) ||
		(migration.state !== 'complete' &&
			(pointer.authoringGeneration ?? version.authoringGeneration ?? 0) !== migration.generation)
	)
		throw unavailable();
	versionReferences(version);
	const certificate = await readValidationCertificate(ctx, companyId, baseline._id);
	return { company, migration, pointer, version, baseline, certificate };
}
export const begin = internalMutation({
	args: { companyId: v.id('company') },
	returns: progress,
	handler: async (ctx, { companyId }) => {
		const company = await requireCompany(ctx, companyId),
			existing = await ctx.db
				.query('authoringMigrations')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
				.unique();
		if (existing && existing.state !== 'complete' && company.authoringMigration) {
			try {
				const state = await captured(ctx, companyId);
				return {
					state: state.migration.state,
					nextItem: state.migration.nextItem,
					itemCount: state.version.itemCount
				};
			} catch (error) {
				if (!(error instanceof ConvexError) || error.data !== CAPTURE_CHANGED) throw error;
				// A reviewed repair changed the capture. Keep the barrier and restart the full audit.
			}
		}
		const pointer = await currentPointer(ctx, companyId);
		if (!pointer || !company.baselineId)
			throw new ConvexError('The company has no active template.');
		const version = await ctx.db.get('templateVersions', pointer.versionId);
		if (!version || version.companyId !== companyId || version.baselineId !== company.baselineId)
			throw unavailable();
		const { baseline, blocks } = await readBaseline(ctx, company.baselineId, companyId);
		if (baseline.state !== 'active') throw unavailable();
		const certificate = await readValidationCertificate(ctx, companyId, baseline._id);
		if (
			existing?.state === 'complete' &&
			!company.authoringMigration &&
			validationCertified(baseline, certificate, version)
		)
			return {
				state: 'complete' as const,
				nextItem: version.itemCount,
				itemCount: version.itemCount
			};
		// The complete historical reader is already admitted for this version. Its source/body audit
		// is the only whole-playbook audit in migration; staged heads are checked separately below.
		const items = await (await versionReader(ctx, version._id, companyId)).readItems();
		validatePlaybook(blocks, items);
		if (!validationCertified(baseline, certificate))
			await writeValidationFacts(ctx, {
				companyId,
				baselineId: baseline._id,
				fingerprint: baseline.fingerprint,
				blocks
			});
		await ctx.db.patch('company', companyId, { authoringMigration: true });
		await ctx.db.patch('templateVersions', version._id, {
			validation: undefined,
			headReadBytes: 0,
			structureResultBytes: 0
		});
		const migration = {
			companyId,
			baselineId: baseline._id,
			fingerprint: baseline.fingerprint,
			versionId: version._id,
			generation: pointer.authoringGeneration ?? version.authoringGeneration ?? 0,
			state: 'heads' as const,
			nextItem: 0
		};
		if (existing) await ctx.db.replace('authoringMigrations', existing._id, migration);
		else await ctx.db.insert('authoringMigrations', migration);
		return { state: migration.state, nextItem: 0, itemCount: version.itemCount };
	}
});
/** At most eight body/head pairs: bounded even when each business rule is 500 KB. */
export const step = internalMutation({
	args: { companyId: v.id('company') },
	returns: progress,
	handler: async (ctx, { companyId }) => {
		const { migration, version, baseline } = await captured(ctx, companyId);
		if (migration.state === 'versions') {
			const page = await ctx.db
				.query('templateVersions')
				.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
				.paginate({ cursor: migration.versionCursor ?? null, numItems: 1 });
			for (const stored of page.page) {
				versionReferences(stored);
				const parent = await ctx.db.get('baselines', stored.baselineId);
				if (!parent || parent.companyId !== companyId) throw unavailable();
				let contentReadBytes = parent.chunkReadBytes,
					itemJsonBytes = 2;
				for (let offset = 0; offset < stored.items.length; offset += 64) {
					const batch = stored.items.slice(offset, offset + 64),
						revisions = await Promise.all(
							batch.map((ref) => ctx.db.get('playbookItemRevisions', ref.revisionId))
						);
					for (const [i, revision] of revisions.entries()) {
						if (
							!revision ||
							revision.companyId !== companyId ||
							revision.itemId !== batch[i].itemId
						)
							throw unavailable();
						contentReadBytes += documentBytes(revision);
						itemJsonBytes += new TextEncoder().encode(
							JSON.stringify(historicalRevision(revision))
						).byteLength;
					}
				}
				itemJsonBytes += Math.max(0, stored.itemCount - 1);
				const snapshotBytes = parent.blocksJsonBytes + itemJsonBytes + 20;
				templateReadCapacity({ ...stored, contentReadBytes, snapshotBytes }, parent);
				await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(stored) });
				await ctx.db.patch('templateVersions', stored._id, { contentReadBytes, snapshotBytes });
			}
			const state = page.isDone ? ('certify' as const) : ('versions' as const);
			await ctx.db.patch('authoringMigrations', migration._id, {
				state,
				versionCursor: page.continueCursor
			});
			return { state, nextItem: migration.nextItem, itemCount: version.itemCount };
		}
		if (migration.state !== 'heads')
			return { state: migration.state, nextItem: migration.nextItem, itemCount: version.itemCount };
		const end = Math.min(version.items.length, migration.nextItem + 8);
		let headReadBytes = version.headReadBytes ?? 0,
			structureResultBytes = version.structureResultBytes ?? 0,
			contentReadBytes = version.contentReadBytes;
		for (let i = migration.nextItem; i < end; i++) {
			const reference = version.items[i],
				head = await ctx.db.get('playbookItems', reference.itemId),
				revision = await ctx.db.get('playbookItemRevisions', reference.revisionId);
			if (
				!head ||
				!revision ||
				head.companyId !== companyId ||
				revision.companyId !== companyId ||
				head.currentRevisionId !== revision._id ||
				revision.itemId !== head._id ||
				revision.itemCreatedAt !== head._creationTime ||
				revision.contentRevision !== head.contentRevision
			)
				throw unavailable();
			if (
				!('format' in head) &&
				canonicalFingerprint(businessItem(head)) !==
					canonicalFingerprint(businessItem(revision.body))
			)
				throw unavailable();
			const renderKey = 'format' in head ? head.renderKey : head._id;
			const saved = {
				...liveRevision(revision),
				renderKey,
				...(head.lastOperation ? { lastOperation: head.lastOperation } : {})
			};
			const nextHead = { ...compactHead(saved), _id: head._id, _creationTime: head._creationTime };
			const nextRevision = {
				...revision,
				renderKey,
				...(head.lastOperation ? { lastOperation: head.lastOperation } : {})
			};
			// Historical business identities and bodies are immutable. Metadata records the live
			// compatibility/replay projection and is included in every native read aggregate.
			contentReadBytes += documentBytes(nextRevision) - documentBytes(revision);
			headReadBytes += documentBytes(nextHead);
			structureResultBytes += getConvexSize(itemStructure(saved));
			await assertStorageCapacity(ctx, {
				documents: 2,
				bytes: documentBytes(nextHead) + documentBytes(nextRevision)
			});
			await ctx.db.replace('playbookItems', head._id, compactHead(saved));
			await ctx.db.patch('playbookItemRevisions', revision._id, {
				renderKey,
				...(head.lastOperation ? { lastOperation: head.lastOperation } : {})
			});
		}
		templateReadCapacity({ ...version, contentReadBytes }, baseline);
		await ctx.db.patch('templateVersions', version._id, {
			contentReadBytes,
			headReadBytes,
			structureResultBytes
		});
		const state = end === version.items.length ? ('versions' as const) : ('heads' as const);
		await ctx.db.patch('authoringMigrations', migration._id, { nextItem: end, state });
		return { state, nextItem: end, itemCount: version.itemCount };
	}
});
export const finish = internalMutation({
	args: { companyId: v.id('company') },
	returns: progress,
	handler: async (ctx, { companyId }) => {
		const { migration, version, baseline, pointer, certificate } = await captured(ctx, companyId);
		if (migration.state === 'complete')
			return {
				state: 'complete' as const,
				nextItem: version.itemCount,
				itemCount: version.itemCount
			};
		if (
			migration.state !== 'certify' ||
			migration.nextItem !== version.itemCount ||
			!validationCertified(baseline, certificate)
		)
			throw unavailable();
		const heads = await ctx.db
			.query('playbookItems')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(4001);
		orderedHeads(version, heads);
		if (
			heads.reduce((sum, head) => sum + documentBytes(head), 0) !== version.headReadBytes ||
			heads.reduce(
				(sum, head) =>
					sum +
					getConvexSize({
						_id: head._id,
						_creationTime: head._creationTime,
						companyId: head.companyId,
						contentRevision: head.contentRevision,
						renderKey: 'format' in head ? head.renderKey : head._id,
						...headStructure(head)
					}),
				0
			) !== version.structureResultBytes
		)
			throw unavailable();
		templateReadCapacity(version, baseline);
		authoringReadCapacity(version, baseline, certificate);
		const authoringGeneration = migration.generation + 1,
			structuralGeneration =
				(pointer.structuralGeneration ?? version.structuralGeneration ?? 0) + 1;
		await ctx.db.patch('templateVersions', version._id, {
			validation: { format: VALIDATION_CODEC_VERSION, fingerprint: baseline.fingerprint },
			authoringGeneration,
			structuralGeneration
		});
		await ctx.db.patch('currentTemplate', pointer._id, {
			authoringGeneration,
			structuralGeneration
		});
		await ctx.db.patch('company', companyId, { authoringMigration: undefined });
		await ctx.db.patch('authoringMigrations', migration._id, { state: 'complete' });
		return {
			state: 'complete' as const,
			nextItem: version.itemCount,
			itemCount: version.itemCount
		};
	}
});
