import { sha256 } from '@noble/hashes/sha2.js';
import { ConvexError, v, type Infer } from 'convex/values';
import {
	TEMPLATE_SOURCE_MAX_BLOCKS,
	TEMPLATE_SOURCE_MAX_BYTES,
	DOCX_MAX_BYTES,
	DOCX_PARSER_VERSION
} from '../lib/document/import/limits';
import { sourceBlock } from '../lib/document/source-validators';
import { validateDocumentSource } from '../lib/document/validate-source';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
	httpAction,
	internalMutation,
	internalQuery,
	query,
	type ActionCtx,
	type QueryCtx
} from './_generated/server';
import { requirePermission } from './auth';
import { templateSourceIntegrity, writeTemplateSourceChunks } from './templateSourceStorage';
import { CLEANUP_DISCOVERY_PAGE_SIZE, cleanupBudget } from './cleanup';
import { assertStorageCapacity, documentBytes } from './storageCapacity';
import { deleteUnownedFile } from './storageOwnership';
import { currentPointer } from './templates';
import { pendingInitialSetup, resolveSetupBooking } from './csmSetupState';
import { blockingInitialGuard } from './csmErasureGuards';
import { replacementState } from './csmReplacements';

import { DOCX_TYPE, issue, preparation, templateSetupStatus } from './templateUploadValidators';
import {
	uploadErrorMessage as message,
	readUploadBody,
	uploadResponse as response,
	uploadPreflightResponse
} from './uploadHttp';

const UPLOAD_TTL = 90 * 24 * 60 * 60_000;
/** The company owns this source even when its uploader has left. Never scan upload history. */
export async function currentPendingTemplate(ctx: QueryCtx, company: Doc<'company'>) {
	if (!company.pendingTemplateSourceId) return null;
	const source = await ctx.db.get('templateSources', company.pendingTemplateSourceId);
	if (
		!source ||
		source.companyId !== company._id ||
		source.source !== 'docx' ||
		source.state !== 'pending'
	)
		throw new ConvexError('The pending upload is unavailable. Reload and try again.');
	return source;
}
export const status = query({
	args: { membershipId: v.id('memberships') },
	returns: templateSetupStatus,
	handler: async (ctx, { membershipId }): Promise<Infer<typeof templateSetupStatus>> => {
		const { company } = await requirePermission(ctx, 'manageTemplate', membershipId);
		if (company.templateSourceId) return { kind: 'released' };
		const [booking, source] = await Promise.all([
			resolveSetupBooking(ctx, company),
			currentPendingTemplate(ctx, company)
		]);
		const pending = source ? { filename: source.filename } : null;
		if (booking.kind === 'confirmed')
			return pending ? { kind: 'waiting', pending } : { kind: 'upload' };
		if (booking.kind === 'initial') {
			const attempt = await pendingInitialSetup(ctx, company._id);
			return {
				kind: 'booking',
				booking: {
					kind: 'initial',
					state: (await blockingInitialGuard(ctx, company._id))
						? 'uncertain'
						: !attempt
							? 'ready'
							: attempt.state === 'unknown'
								? 'uncertain'
								: 'in-progress'
				},
				pending
			};
		}
		if (booking.kind === 'cancelled')
			return {
				kind: 'booking',
				booking: {
					kind: 'replacement',
					appointmentId: booking.appointment._id,
					currentUid: booking.appointment.currentUid,
					state: (await replacementState(ctx, booking.appointment)).state
				},
				pending
			};
		return { kind: 'booking', booking: { kind: 'unavailable' }, pending };
	}
});

async function uploadCompany(ctx: QueryCtx, membershipId: Id<'memberships'>) {
	const access = await requirePermission(ctx, 'manageTemplate', membershipId);
	const { company, companyId } = access;
	const [booking, pointer, versions, items, active, revisions, receipts] = await Promise.all([
		resolveSetupBooking(ctx, company),
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
			.withIndex('by_companyId_and_state', (q) =>
				q.eq('companyId', companyId).eq('state', 'active')
			)
			.first(),
		ctx.db
			.query('playbookItemRevisions')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(1),
		ctx.db
			.query('playbookItemCreationReceipts')
			.withIndex('by_companyId', (q) => q.eq('companyId', companyId))
			.take(1)
	]);
	if (
		company.templateSourceId ||
		pointer ||
		versions.length ||
		items.length ||
		active ||
		revisions.length ||
		receipts.length
	)
		throw new ConvexError(
			'This company already has a template source or an import in progress. Its template source cannot be replaced.'
		);
	if (booking.kind !== 'confirmed')
		throw new ConvexError('Confirm your setup call before uploading a template.');
	return { access, pending: await currentPendingTemplate(ctx, company) };
}
export const authorize = internalQuery({
	args: { membershipId: v.id('memberships') },
	returns: v.null(),
	handler: async (ctx, { membershipId }) => {
		await uploadCompany(ctx, membershipId);
		return null;
	}
});
function reusable(
	pending: Awaited<ReturnType<typeof currentPendingTemplate>>,
	uploaderId: Id<'profiles'>,
	fileHash: string
) {
	return pending &&
		pending.uploaderId === uploaderId &&
		pending.fileHash === fileHash &&
		pending.parserVersion === DOCX_PARSER_VERSION &&
		pending.expiresAt > Date.now()
		? pending
		: null;
}
// This authoritative transaction rechecks reuse after the bytes have been hashed.
export const reuse = internalMutation({
	args: { membershipId: v.id('memberships'), fileHash: v.string() },
	returns: v.union(v.null(), preparation),
	handler: async (ctx, { membershipId, fileHash }) => {
		const { access, pending } = await uploadCompany(ctx, membershipId);
		const existing = reusable(pending, access.profile._id, fileHash);
		return existing
			? {
					pendingTemplateSourceId: existing._id,
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
	returns: v.object({ pendingTemplateSourceId: v.id('templateSources') }),
	handler: async (ctx, args) => {
		const { access, pending } = await uploadCompany(ctx, args.membershipId);
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
		const existing = reusable(pending, access.profile._id, args.fileHash);
		if (existing && existing.fingerprint !== integrity.fingerprint)
			throw new ConvexError('The prepared document is inconsistent.');
		if (existing) return { pendingTemplateSourceId: existing._id };
		const deleting = await ctx.db
			.query('templateSources')
			.withIndex('by_companyId_and_state', (q) =>
				q.eq('companyId', access.companyId).eq('state', 'deleting')
			)
			.take(16);
		if (deleting.length + Number(!!pending) >= 16)
			throw new ConvexError('Too many unfinished uploads. Try again after they expire.');
		const uploadedAt = Date.now();
		const expiresAt = uploadedAt + UPLOAD_TTL;
		const pendingTemplateSource = {
			companyId: access.companyId,
			state: 'pending' as const,
			source: 'docx' as const,
			originalFileId: args.originalFileId,
			filename: args.filename,
			fileHash: args.fileHash,
			...integrity,
			parserVersion: DOCX_PARSER_VERSION,
			uploaderId: access.profile._id,
			uploadedAt,
			issues: args.issues,
			blockCount: args.blocks.length,
			chunkCount: 0,
			chunkReadBytes: 0,
			expiresAt
		};
		await assertStorageCapacity(ctx, {
			documents: 1,
			bytes: documentBytes(pendingTemplateSource)
		});
		const pendingTemplateSourceId = await ctx.db.insert('templateSources', pendingTemplateSource);
		const counters = await writeTemplateSourceChunks(ctx, {
			companyId: access.companyId,
			templateSourceId: pendingTemplateSourceId,
			blocks: args.blocks
		});
		await assertStorageCapacity(ctx, {
			documents: 1,
			bytes: documentBytes({ ...pendingTemplateSource, ...counters })
		});
		await ctx.db.patch('templateSources', pendingTemplateSourceId, counters);
		await assertStorageCapacity(ctx, {
			documents: 1,
			bytes: documentBytes({ ...access.company, pendingTemplateSourceId })
		});
		await ctx.db.patch('company', access.companyId, { pendingTemplateSourceId });
		if (pending) {
			await ctx.db.patch('templateSources', pending._id, {
				state: 'deleting',
				expiresAt: uploadedAt
			});
			await ctx.scheduler.runAfter(0, internal.templateUploads.expire, {
				templateSourceId: pending._id
			});
		}
		await ctx.scheduler.runAfter(UPLOAD_TTL, internal.templateUploads.expire, {
			templateSourceId: pendingTemplateSourceId
		});
		return { pendingTemplateSourceId };
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
			(templateSource.state !== 'pending' && templateSource.state !== 'deleting') ||
			typeof templateSource.expiresAt !== 'number' ||
			!Number.isFinite(templateSource.expiresAt) ||
			templateSource.expiresAt > Date.now()
		)
			return null;
		const company = await ctx.db.get('company', templateSource.companyId);
		if (company?.templateSourceId === templateSourceId) return null;
		if (company?.pendingTemplateSourceId === templateSourceId)
			await ctx.db.patch('company', company._id, { pendingTemplateSourceId: undefined });
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
export const expirePending = internalMutation({
	args: {
		state: v.optional(v.union(v.literal('pending'), v.literal('deleting'))),
		cursor: v.optional(v.union(v.string(), v.null()))
	},
	returns: v.null(),
	handler: async (ctx, { state, cursor }) => {
		if (!state) {
			for (const state of ['pending', 'deleting'] as const) {
				const expired = await ctx.db
					.query('templateSources')
					.withIndex('by_state_and_expiresAt', (q) =>
						q.eq('state', state).gt('expiresAt', 0).lte('expiresAt', Date.now())
					)
					.first();
				if (expired)
					await ctx.scheduler.runAfter(0, internal.templateUploads.expirePending, { state });
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
			await ctx.scheduler.runAfter(0, internal.templateUploads.expirePending, {
				state,
				cursor: result.continueCursor
			});
		return null;
	}
});
