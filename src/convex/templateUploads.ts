import { requireTerminologyReady } from './terminologyMaintenance';
import { sha256 } from '@noble/hashes/sha2.js';
import { ConvexError, v } from 'convex/values';
import {
	TEMPLATE_SOURCE_MAX_BLOCKS,
	TEMPLATE_SOURCE_MAX_BYTES,
	DOCX_MAX_BYTES,
	DOCX_PARSER_VERSION
} from '../lib/document/import/limits';
import { sourceBlock } from '../lib/document/source-validators';
import { validateDocumentSource } from '../lib/document/validate-source';
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
import { templateSourceIntegrity, writeTemplateSourceChunks } from './templateSourceStorage';
import { CLEANUP_DISCOVERY_PAGE_SIZE, cleanupBudget } from './cleanup';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { deleteUnownedFile } from './storageOwnership';
import { currentPointer } from './templates';

import { DOCX_TYPE, issue, preparation } from './templateUploadValidators';
import {
	uploadErrorMessage as message,
	readUploadBody,
	uploadResponse as response,
	uploadPreflightResponse
} from './uploadHttp';

const UPLOAD_TTL = 24 * 60 * 60_000;
async function emptyCompany(ctx: QueryCtx, companyId: Id<'company'>) {
	const [company, pointer, versions, items, templateSources] = await Promise.all([
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
			.query('templateSources')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(17)
	]);
	if (
		company?.templateSourceId ||
		pointer ||
		versions.length ||
		items.length ||
		templateSources.some((b) => b.state === 'active' || b.source !== 'docx')
	)
		throw new ConvexError(
			'This company already has a template source or an import in progress. Its template source cannot be replaced.'
		);
	return templateSources;
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
					preparedTemplateSourceId: existing._id,
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
		blocks: v.array(sourceBlock),
		issues: v.array(issue)
	},
	returns: v.object({ preparedTemplateSourceId: v.id('templateSources') }),
	handler: async (ctx, args) => {
		const access = await requirePermission(ctx, 'manageTemplate', args.membershipId);
		const prepared = await emptyCompany(ctx, access.companyId);
		validateDocumentSource(args.blocks);
		if (args.blocks.length > TEMPLATE_SOURCE_MAX_BLOCKS)
			throw new ConvexError('The prepared document failed validation. Select the DOCX again.');
		const integrity = templateSourceIntegrity(args.blocks);
		if (
			integrity.blocksJsonBytes > TEMPLATE_SOURCE_MAX_BYTES ||
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
		if (existing) return { preparedTemplateSourceId: existing._id };
		if (prepared.length >= 16)
			throw new ConvexError('Too many unfinished uploads. Try again after they expire.');
		const expiresAt = Date.now() + UPLOAD_TTL;
		const preparedTemplateSource = {
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
		await assertStorageCapacity(ctx, {
			documents: 1,
			bytes: documentBytes(preparedTemplateSource)
		});
		const preparedTemplateSourceId = await ctx.db.insert('templateSources', preparedTemplateSource);
		const counters = await writeTemplateSourceChunks(ctx, {
			companyId: access.companyId,
			templateSourceId: preparedTemplateSourceId,
			blocks: args.blocks
		});
		await assertStorageCapacity(ctx, {
			documents: 1,
			bytes: documentBytes({ ...preparedTemplateSource, ...counters })
		});
		await ctx.db.patch('templateSources', preparedTemplateSourceId, counters);
		await ctx.scheduler.runAfter(UPLOAD_TTL, internal.templateUploads.expire, {
			templateSourceId: preparedTemplateSourceId
		});
		return { preparedTemplateSourceId };
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
			await ctx.runQuery(internal.templateUploads.authorize, { membershipId });
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
			const existing = await ctx.runMutation(internal.templateUploads.reuse, {
				membershipId,
				fileHash
			});
			if (existing) return response(existing);
		} catch (error) {
			return response({ error: message(error, 'Unable to prepare this upload. Try again.') }, 409);
		}
		const originalFileId = await ctx.storage.store(new Blob(body.chunks, { type: DOCX_TYPE }));
		try {
			const result = await ctx.runAction(internal.templateSourceParser.prepare, {
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
		console.error('Unable to prepare template source upload.', error);
		return response({ error: 'Unable to upload your template. Try again.' }, 500);
	}
});
// Reference-safe deletion is independent of response success, including dispatch failure.
async function discardLater(ctx: ActionCtx, fileId: Id<'_storage'>) {
	try {
		await ctx.scheduler.runAfter(0, internal.storageOwnership.discardFile, { fileId });
	} catch (error) {
		console.error('Unable to dispatch unused template source file cleanup.', error);
	}
}
export const preflight = httpAction(async () => uploadPreflightResponse());

export const expire = internalMutation({
	args: { templateSourceId: v.id('templateSources') },
	returns: v.null(),
	handler: async (ctx, { templateSourceId }) => {
		const templateSource = await ctx.db.get('templateSources', templateSourceId);
		if (
			!templateSource ||
			templateSource.source !== 'docx' ||
			(templateSource.state !== 'prepared' && templateSource.state !== 'deleting') ||
			typeof templateSource.expiresAt !== 'number' ||
			!Number.isFinite(templateSource.expiresAt) ||
			templateSource.expiresAt > Date.now()
		)
			return null;
		await ctx.db.patch('templateSources', templateSourceId, { state: 'deleting' });
		const { drain } = cleanupBudget(ctx);
		let drained = await drain(
			'templateSourceChunks',
			ctx.db
				.query('templateSourceChunks')
				.withIndex('by_companyId_and_templateSourceId_and_order', (q) =>
					q.eq('companyId', templateSource.companyId).eq('templateSourceId', templateSourceId)
				)
		);
		if (drained)
			drained = await drain(
				'templateSourceValidationChunks',
				ctx.db
					.query('templateSourceValidationChunks')
					.withIndex('by_companyId_and_templateSourceId_and_order', (q) =>
						q.eq('companyId', templateSource.companyId).eq('templateSourceId', templateSourceId)
					)
			);
		if (drained)
			drained = await drain(
				'templateSourceCertificates',
				ctx.db
					.query('templateSourceCertificates')
					.withIndex('by_companyId_and_templateSourceId', (q) =>
						q.eq('companyId', templateSource.companyId).eq('templateSourceId', templateSourceId)
					)
			);
		if (!drained)
			await ctx.scheduler.runAfter(0, internal.templateUploads.expire, { templateSourceId });
		else {
			await ctx.db.delete('templateSources', templateSourceId);
			await deleteUnownedFile(ctx, templateSource.originalFileId);
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
		requireTerminologyReady();
		if (!state) {
			for (const state of ['prepared', 'deleting'] as const) {
				const expired = await ctx.db
					.query('templateSources')
					.withIndex('by_state_and_expiresAt', (q) =>
						q.eq('state', state).gt('expiresAt', 0).lte('expiresAt', Date.now())
					)
					.first();
				if (expired)
					await ctx.scheduler.runAfter(0, internal.templateUploads.expirePrepared, { state });
			}
			return null;
		}
		const result = await ctx.db
			.query('templateSources')
			.withIndex('by_state_and_expiresAt', (q) =>
				q.eq('state', state).gt('expiresAt', 0).lte('expiresAt', Date.now())
			)
			.paginate({
				cursor: cursor ?? null,
				numItems: CLEANUP_DISCOVERY_PAGE_SIZE,
				maximumRowsRead: CLEANUP_DISCOVERY_PAGE_SIZE,
				maximumBytesRead: 2 * 1024 * 1024
			});
		for (const templateSource of result.page)
			if (templateSource.source === 'docx')
				await ctx.scheduler.runAfter(0, internal.templateUploads.expire, {
					templateSourceId: templateSource._id
				});
		if (!result.isDone)
			await ctx.scheduler.runAfter(0, internal.templateUploads.expirePrepared, {
				state,
				cursor: result.continueCursor
			});
		return null;
	}
});
