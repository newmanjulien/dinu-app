import { sha256 } from '@noble/hashes/sha2.js';
import { ConvexError, v } from 'convex/values';
import {
	httpAction,
	internalMutation,
	internalQuery,
	type QueryCtx,
	type ActionCtx
} from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { requirePermission } from './auth';
import { currentPointer } from './templates';
import { baselineBlock } from './sourceValidators';
import { canonicalBaselineFingerprint } from './baselineStorage';
import { validateBaseline } from '../lib/contract/validate-source';
import {
	BASELINE_MAX_BLOCKS,
	BASELINE_MAX_BYTES,
	DOCX_MAX_BYTES,
	DOCX_PARSER_VERSION
} from '../lib/contract/import/limits';

import { DOCX_TYPE, issue, preparation } from './baselineUploadValidators';
import { documentFileOwned } from './storageOwnership';
import { PDF_CONTENT_TYPE } from '../lib/delegation';

const UPLOAD_TTL = 24 * 60 * 60_000;
const cors = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Authorization, Content-Type',
	'Cache-Control': 'no-store'
};
function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...cors, 'Content-Type': 'application/json' }
	});
}
function message(error: unknown, fallback: string) {
	if (error instanceof ConvexError) {
		if (typeof error.data === 'string') return error.data;
		if (error.data && typeof error.data === 'object' && 'message' in error.data)
			return String(error.data.message);
	}
	return fallback;
}
async function emptyCompany(ctx: QueryCtx, companyId: Id<'company'>) {
	const [pointer, versions, items, baselines] = await Promise.all([
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
		pointer ||
		versions.length ||
		items.length ||
		baselines.some((b) => b.state === 'published' || b.source !== 'docx')
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
			(b.expiresAt ?? 0) > Date.now()
	);
}
// This authoritative transaction rechecks reuse after the bytes have been hashed.
export const reuse = internalMutation({
	args: { membershipId: v.id('memberships'), fileHash: v.string() },
	returns: v.union(v.null(), preparation),
	handler: async (ctx, { membershipId, fileHash }) => {
		const access = await requirePermission(ctx, 'manageTemplate', membershipId);
		const existing = reusable(await emptyCompany(ctx, access.companyId), access._id, fileHash);
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
		if (
			!args.blocks.length ||
			args.blocks.length > BASELINE_MAX_BLOCKS ||
			new TextEncoder().encode(JSON.stringify(args.blocks)).byteLength > BASELINE_MAX_BYTES ||
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
		const fingerprint = canonicalBaselineFingerprint(args.blocks);
		const existing = reusable(prepared, access._id, args.fileHash);
		if (existing && existing.fingerprint !== fingerprint)
			throw new ConvexError('The prepared document is inconsistent.');
		if (existing) return { preparedBaselineId: existing._id };
		if (prepared.length >= 16)
			throw new ConvexError('Too many unfinished uploads. Try again after they expire.');
		const expiresAt = Date.now() + UPLOAD_TTL;
		const preparedBaselineId = await ctx.db.insert('baselines', {
			companyId: access.companyId,
			state: 'prepared',
			source: 'docx',
			originalFileId: args.originalFileId,
			filename: args.filename,
			fileHash: args.fileHash,
			fingerprint,
			parserVersion: DOCX_PARSER_VERSION,
			uploaderId: access._id,
			issues: args.issues,
			blockCount: args.blocks.length,
			expiresAt
		});
		for (const block of args.blocks)
			await ctx.db.insert('contractBlocks', {
				...block,
				companyId: access.companyId,
				baselineId: preparedBaselineId
			});
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
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		const hash = sha256.create();
		let size = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.byteLength;
				if (size > DOCX_MAX_BYTES) {
					await reader.cancel();
					return response({ error: 'Choose a DOCX no larger than 10 MB.' }, 413);
				}
				chunks.push(chunk.value);
				hash.update(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
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
		const originalFileId = await ctx.storage.store(new Blob(chunks, { type: DOCX_TYPE }));
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
		await ctx.scheduler.runAfter(0, internal.baselineUploads.discardFile, { fileId });
	} catch (error) {
		console.error('Unable to dispatch unused baseline file cleanup.', error);
	}
}
export const preflight = httpAction(async () => new Response(null, { status: 204, headers: cors }));

// A failed response can follow a committed preparation. Never delete referenced bytes.
export const discardFile = internalMutation({
	args: { fileId: v.id('_storage') },
	returns: v.null(),
	handler: async (ctx, { fileId }) => {
		if (!(await documentFileOwned(ctx, fileId))) await ctx.storage.delete(fileId);
		return null;
	}
});

export const expire = internalMutation({
	args: { baselineId: v.id('baselines') },
	returns: v.null(),
	handler: async (ctx, { baselineId }) => {
		const baseline = await ctx.db.get('baselines', baselineId);
		if (
			!baseline ||
			baseline.source !== 'docx' ||
			baseline.state === 'published' ||
			(baseline.expiresAt ?? Infinity) > Date.now()
		)
			return null;
		const rows = await ctx.db
			.query('contractBlocks')
			.withIndex('by_baselineId_and_order', (q) => q.eq('baselineId', baselineId))
			.take(64);
		await ctx.db.patch('baselines', baselineId, { state: 'deleting' });
		for (const row of rows) await ctx.db.delete('contractBlocks', row._id);
		if (rows.length === 64)
			await ctx.scheduler.runAfter(0, internal.baselineUploads.expire, { baselineId });
		else {
			if (baseline.originalFileId) await ctx.storage.delete(baseline.originalFileId);
			await ctx.db.delete('baselines', baselineId);
		}
		return null;
	}
});
export const expirePrepared = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		for (const state of ['prepared', 'deleting'] as const) {
			const baselines = await ctx.db
				.query('baselines')
				.withIndex('by_state_and_expiresAt', (q) =>
					q.eq('state', state).gt('expiresAt', 0).lte('expiresAt', Date.now())
				)
				.take(10);
			for (const baseline of baselines)
				if (baseline.source === 'docx')
					await ctx.scheduler.runAfter(0, internal.baselineUploads.expire, {
						baselineId: baseline._id
					});
		}
		return null;
	}
});
// Recover interrupted uploads/exports once per creation interval. Referenced originals
// are subsequently deleted by baseline expiry or company deletion, not rescanned here.
export const cleanOrphanFiles = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())), cutoff: v.optional(v.number()) },
	returns: v.null(),
	handler: async (ctx, args) => {
		const sweep = await ctx.db
			.query('fileSweeps')
			.withIndex('by_kind', (q) => q.eq('kind', 'docx-orphans'))
			.unique();
		// A duplicate continuation must not advance a newer page or interval.
		if (
			args.cutoff !== undefined &&
			(sweep?.active?.cutoff !== args.cutoff || sweep.active.cursor !== (args.cursor ?? null))
		)
			return null;
		const cutoff = sweep?.active?.cutoff ?? Date.now() - UPLOAD_TTL;
		const completedThrough = sweep?.completedThrough ?? null;
		if (completedThrough !== null && cutoff <= completedThrough) return null;
		const sweepId =
			sweep?._id ??
			(await ctx.db.insert('fileSweeps', {
				kind: 'docx-orphans',
				completedThrough: null,
				active: { cutoff, cursor: null }
			}));
		const result = await ctx.db.system
			.query('_storage')
			.withIndex('by_creation_time', (q) =>
				completedThrough === null
					? q.lte('_creationTime', cutoff)
					: q.gt('_creationTime', completedThrough).lte('_creationTime', cutoff)
			)
			.paginate({ cursor: sweep?.active?.cursor ?? null, numItems: 25 });
		for (const file of result.page) {
			if (file.contentType !== DOCX_TYPE && file.contentType !== PDF_CONTENT_TYPE) continue;
			if (!(await documentFileOwned(ctx, file._id))) await ctx.storage.delete(file._id);
		}
		await ctx.db.patch(
			'fileSweeps',
			sweepId,
			result.isDone
				? { completedThrough: cutoff, active: null }
				: { active: { cutoff, cursor: result.continueCursor } }
		);
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.baselineUploads.cleanOrphanFiles, {
				cursor: result.continueCursor,
				cutoff
			});
		return null;
	}
});
