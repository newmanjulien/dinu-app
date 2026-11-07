import { sha256 } from '@noble/hashes/sha2.js';
import { ConvexError, v } from 'convex/values';
import {
	BASELINE_MAX_BLOCKS,
	BASELINE_MAX_BYTES,
	DOCX_MAX_BYTES,
	DOCX_PARSER_VERSION
} from '../lib/contract/import/limits';
import { baselineBlock } from '../lib/contract/source-validators';
import { validateBaseline } from '../lib/contract/validate-source';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
	httpAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
	type QueryCtx
} from './_generated/server';
import { requirePermission } from './auth';
import { baselineIntegrity, writeBaselineChunks } from './baselineStorage';
import { CLEANUP_DISCOVERY_PAGE_SIZE, cleanupBudget } from './cleanup';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { deleteUnownedFile } from './storageOwnership';
import { currentPointer } from './templates';

import { DOCX_TYPE, issue, preparation } from './baselineUploadValidators';
import {
	uploadErrorMessage as message,
	readUploadBody,
	uploadResponse as response,
	uploadPreflightResponse
} from './uploadHttp';

const UPLOAD_TTL = 24 * 60 * 60_000;
async function emptyCompany(ctx: QueryCtx, companyId: Id<'company'>) {
	const [company, pointer, versions, items, baselines] = await Promise.all([
		ctx.db.get('company', companyId),
		currentPointer(ctx, companyId),
		ctx.db
			.query('templateVersions')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(1),
		ctx.db
			.query('playbookItems')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(1),
		ctx.db
			.query('baselines')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(17)
	]);
	if (
		company?.baselineId ||
		pointer ||
		versions.length ||
		items.length ||
		baselines.some((b) => b.state === 'active' || b.source !== 'docx')
	)
		throw new ConvexError(
			'This company already has a baseline or an import in progress. Its baseline cannot be replaced.'
		);
	return baselines;
}
export const authorize = internalQuery({
	args: { membershipId: v.id('memberships') },
	returns: v.null(),
	handler: async (ctx, { membershipId }) => {
		const access = await requirePermission(ctx, 'manageTemplate', membershipId);
		await emptyCompany(ctx, access.companyId);
		return null;
	}
});
function reusable(
	prepared: Awaited<ReturnType<typeof emptyCompany>>,
	uploaderId: Id<'profiles'>,
	fileHash: string
) {
	return prepared.find(
		(b) =>
			b.state === 'prepared' &&
			b.source === 'docx' &&
			b.uploaderId === uploaderId &&
			b.fileHash === fileHash &&
			b.parserVersion === DOCX_PARSER_VERSION &&
			b.expiresAt > Date.now()
	);
}
// This authoritative transaction rechecks reuse after the bytes have been hashed.
export const reuse = internalMutation({
	args: { membershipId: v.id('memberships'), fileHash: v.string() },
	returns: v.union(v.null(), preparation),
	handler: async (ctx, { membershipId, fileHash }) => {
		const access = await requirePermission(ctx, 'manageTemplate', membershipId);
		const existing = reusable(
			await emptyCompany(ctx, access.companyId),
			access.profile._id,
			fileHash
		);
		return existing
			? {
					preparedBaselineId: existing._id,
					blockCount: existing.blockCount,
					issues: existing.issues
				}
			: null;
	}
});
// Only the internal Node parser can provide these blocks.
export const prepare = internalMutation({
	args: {
		membershipId: v.id('memberships'),
		originalFileId: v.id('_storage'),
		filename: v.string(),
		fileHash: v.string(),
		blocks: v.array(baselineBlock),
		issues: v.array(issue)
	},
	returns: v.object({ preparedBaselineId: v.id('baselines') }),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'manageTemplate', args.membershipId);
		const prepared = await emptyCompany(ctx, access.companyId);
		validateBaseline(args.blocks);
		if (args.blocks.length > BASELINE_MAX_BLOCKS)
			throw new ConvexError('The prepared document failed validation. Select the DOCX again.');
		const integrity = baselineIntegrity(args.blocks);
		if (
			integrity.blocksJsonBytes > BASELINE_MAX_BYTES ||
			args.issues.length > 600 ||
			args.issues.some(
				(i) =>
					i.severity === 'error' ||
					i.location.length > 1200 ||
					i.message.length > 1200 ||
					(i.context?.length ?? 0) > 1200
			)
		)
			throw new ConvexError('The prepared document failed validation. Select the DOCX again.');
		const file = await ctx.db.system.get('_storage', args.originalFileId);
		if (
			!file ||
			file.size > DOCX_MAX_BYTES ||
			file.contentType !== DOCX_TYPE ||
			!/^[a-f0-9]{64}$/.test(args.fileHash) ||
			Array.from(
				Uint8Array.from(atob(file.sha256), (c) => c.charCodeAt(0)),
				(byte) => byte.toString(16).padStart(2, '0')
			).join('') !== args.fileHash
		)
			throw new ConvexError('The uploaded Word file is unavailable. Select it again.');
		const existing = reusable(prepared, access.profile._id, args.fileHash);
		if (existing && existing.fingerprint !== integrity.fingerprint)
			throw new ConvexError('The prepared document is inconsistent.');
		if (existing) return { preparedBaselineId: existing._id };
		if (prepared.length >= 16)
			throw new ConvexError('Too many unfinished uploads. Try again after they expire.');
		const expiresAt = Date.now() + UPLOAD_TTL;
		const preparedBaseline = {
			companyId: access.companyId,
			state: 'prepared' as const,
			source: 'docx' as const,
			originalFileId: args.originalFileId,
			filename: args.filename,
			fileHash: args.fileHash,
			...integrity,
			parserVersion: DOCX_PARSER_VERSION,
			uploaderId: access.profile._id,
			issues: args.issues,
			blockCount: args.blocks.length,
			chunkCount: 0,
			chunkReadBytes: 0,
			expiresAt
		};
		await assertStorageCapacity(ctx, { documents: 1, bytes: documentBytes(preparedBaseline) });
		const preparedBaselineId = await ctx.db.insert('baselines', preparedBaseline);
		const counters = await writeBaselineChunks(ctx, {
			companyId: access.companyId,
			baselineId: preparedBaselineId,
			blocks: args.blocks
		});
		await assertStorageCapacity(ctx, {
			documents: 1,
			bytes: documentBytes({ ...preparedBaseline, ...counters })
		});
		await ctx.db.patch('baselines', preparedBaselineId, counters);
		await ctx.scheduler.runAfter(UPLOAD_TTL, internal.baselineUploads.expire, {
			baselineId: preparedBaselineId
		});
		return { preparedBaselineId };
	}
});

export const upload = httpAction(async (ctx, request) => {
	try {
		if (!(await ctx.auth.getUserIdentity())) return response({ error: 'Sign in required.' }, 401);
		const params = new URL(request.url).searchParams;
		const membershipId = params.get('membershipId') as Id<'memberships'> | null;
		const filename = params.get('filename') ?? '';
		if (!membershipId) return response({ error: 'Company access is required.' }, 403);
		try {
			await ctx.runQuery(internal.baselineUploads.authorize, { membershipId });
		} catch (error) {
			return response(
				{ error: message(error, 'Unable to upload for this company. Reload and try again.') },
				403
			);
		}
		if (
			request.headers.get('content-type')?.split(';')[0].trim() !== DOCX_TYPE ||
			!/\.docx$/i.test(filename) ||
			filename.length > 255
		)
			return response({ error: 'Choose a .docx Word document.' }, 400);
		if (Number(request.headers.get('content-length')) > DOCX_MAX_BYTES)
			return response({ error: 'Choose a DOCX no larger than 10 MB.' }, 413);
		const reader = request.body?.getReader();
		if (!reader) return response({ error: 'The Word file is empty.' }, 400);
		const hash = sha256.create();
		const body = await readUploadBody(reader, DOCX_MAX_BYTES, (chunk) => hash.update(chunk));
		if (!body) return response({ error: 'Choose a DOCX no larger than 10 MB.' }, 413);
		const fileHash = Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join(
			''
		);
		try {
			const existing = await ctx.runMutation(internal.baselineUploads.reuse, {
				membershipId,
				fileHash
			});
			if (existing) return response(existing);
		} catch (error) {
			return response({ error: message(error, 'Unable to prepare this upload. Try again.') }, 409);
		}
		const originalFileId = await ctx.storage.store(new Blob(body.chunks, { type: DOCX_TYPE }));
		try {
			const result = await ctx.runAction(internal.baselineParser.prepare, {
				membershipId,
				originalFileId,
				filename,
				fileHash
			});
			await discardLater(ctx, originalFileId);
			return 'error' in result ? response({ error: result.error }, 400) : response(result);
		} catch (error) {
			await discardLater(ctx, originalFileId);
			return response({ error: message(error, 'Unable to prepare this upload. Try again.') }, 409);
		}
	} catch (error) {
		console.error('Unable to prepare baseline upload.', error);
		return response({ error: 'Unable to upload your contract. Try again.' }, 500);
	}
});
// Reference-safe deletion is independent of response success, including dispatch failure.
async function discardLater(ctx: ActionCtx, fileId: Id<'_storage'>) {
	try {
		await ctx.scheduler.runAfter(0, internal.storageOwnership.discardFile, { fileId });
	} catch (error) {
		console.error('Unable to dispatch unused baseline file cleanup.', error);
	}
}
export const preflight = httpAction(async () => uploadPreflightResponse());

export const expire = internalMutation({
	args: { baselineId: v.id('baselines') },
	returns: v.null(),
	handler: async (ctx, { baselineId }) => {
		const baseline = await ctx.db.get('baselines', baselineId);
		if (
			!baseline ||
			baseline.source !== 'docx' ||
			(baseline.state !== 'prepared' && baseline.state !== 'deleting') ||
			typeof baseline.expiresAt !== 'number' ||
			!Number.isFinite(baseline.expiresAt) ||
			baseline.expiresAt > Date.now()
		)
			return null;
		await ctx.db.patch('baselines', baselineId, { state: 'deleting' });
		const { drain } = cleanupBudget(ctx);
		let drained = await drain(
			'baselineChunks',
			ctx.db
				.query('baselineChunks')
				.withIndex('by_companyId_and_baselineId_and_order', (q) =>
					q.eq('companyId', baseline.companyId).eq('baselineId', baselineId)
				)
		);
		if (drained)
			drained = await drain(
				'baselineValidationChunks',
				ctx.db
					.query('baselineValidationChunks')
					.withIndex('by_companyId_and_baselineId_and_order', (q) =>
						q.eq('companyId', baseline.companyId).eq('baselineId', baselineId)
					)
			);
		if (drained)
			drained = await drain(
				'baselineAuthoring',
				ctx.db
					.query('baselineAuthoring')
					.withIndex('by_companyId_and_baselineId', (q) =>
						q.eq('companyId', baseline.companyId).eq('baselineId', baselineId)
					)
			);
		if (!drained) await ctx.scheduler.runAfter(0, internal.baselineUploads.expire, { baselineId });
		else {
			await ctx.db.delete('baselines', baselineId);
			await deleteUnownedFile(ctx, baseline.originalFileId);
		}
		return null;
	}
});
export const expirePrepared = internalMutation({
	args: {
		state: v.optional(v.union(v.literal('prepared'), v.literal('deleting'))),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	returns: v.null(),
	handler: async (ctx, { state, cursor }) => {
		if (!state) {
			for (const state of ['prepared', 'deleting'] as const) {
				const expired = await ctx.db
					.query('baselines')
					.withIndex('by_state_and_expiresAt', (q) =>
						q.eq('state', state).gt('expiresAt', 0).lte('expiresAt', Date.now())
					)
					.first();
				if (expired)
					await ctx.scheduler.runAfter(0, internal.baselineUploads.expirePrepared, { state });
			}
			return null;
		}
		const result = await ctx.db
			.query('baselines')
			.withIndex('by_state_and_expiresAt', (q) =>
				q.eq('state', state).gt('expiresAt', 0).lte('expiresAt', Date.now())
			)
			.paginate({
				cursor: cursor ?? null,
				numItems: CLEANUP_DISCOVERY_PAGE_SIZE,
				maximumRowsRead: CLEANUP_DISCOVERY_PAGE_SIZE,
				maximumBytesRead: 2 * 1024 * 1024
			});
		for (const baseline of result.page)
			if (baseline.source === 'docx')
				await ctx.scheduler.runAfter(0, internal.baselineUploads.expire, {
					baselineId: baseline._id
				});
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.baselineUploads.expirePrepared, {
				state,
				cursor: result.continueCursor
			});
		return null;
	}
});
