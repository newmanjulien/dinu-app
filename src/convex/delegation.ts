import { ConvexError, v } from 'convex/values';
import {
	query,
	mutation,
	internalQuery,
	internalMutation,
	type QueryCtx,
	type MutationCtx
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { requireMembership, scopedOperation } from './auth';
import {
	catalog,
	submission,
	submitted,
	uploadArgs,
	draftAttachment,
	registeredUpload,
	type Catalog,
	type Submission,
	type Task
} from './delegationValidators';
import {
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_MAX_COUNT,
	DOCX_CONTENT_TYPE,
	PDF_CONTENT_TYPE,
	DELEGATION_TIMEZONE,
	delegationDeadline
} from '../lib/delegation';

const UPLOAD_TTL = 24 * 60 * 60_000;
function canonical(value: unknown) {
	return JSON.stringify(value, (_key, entry) =>
		entry && typeof entry === 'object' && !Array.isArray(entry)
			? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: entry
	);
}
function invalid(message: string): never {
	throw new ConvexError({ code: 'INVALID', message });
}
function rejected(message: string): never {
	throw new ConvexError({ code: 'INVALID', definitive: true, message });
}
function catalogSnapshot(value: Doc<'delegationCatalog'> | null): Catalog | null {
	return value
		? { key: value.key, revision: value.revision, delegate: value.delegate, tasks: value.tasks }
		: null;
}
function identifier(value: string) {
	if (!/^[a-zA-Z0-9-]{1,100}$/.test(value)) invalid('This request is invalid. Reopen the form.');
}
async function admin(ctx: QueryCtx, membershipId: Id<'memberships'>) {
	const access = await requireMembership(ctx, membershipId);
	if (access.role !== 'admin')
		throw new ConvexError({ code: 'FORBIDDEN', message: 'Admin access is required.' });
	return access;
}
const initialCatalog = {
	key: 'default' as const,
	delegate: {
		name: 'Julien Newman',
		avatarPath: '/delegation-julien.jpg',
		introduction:
			"I'm Julien. I'm a real human and I can help get you set up. Delegate a task to me here and I'll get it done"
	},
	tasks: [
		{
			key: 'set-up-contract',
			title: 'Set up a contract',
			description:
				'I’ll set up your contract in Dinu so your team can use it as a starting point for negotiations. Share the contract you’d like to use and tell me what it’s for, along with any clauses or details that need particular attention.',
			businessDays: 2,
			questions: [
				{
					key: 'focus',
					label: 'What contract are we setting up, and what should I focus on?',
					required: true,
					kind: 'textarea'
				}
			]
		},
		{
			key: 'build-playbook',
			title: 'Build a negotiation playbook',
			description:
				'I’ll build a negotiation playbook for your contract with clear clause explanations, approved alternatives, and guidance on when to hold firm or ask for approval. Share your contract and describe the issues your team encounters, including any positions or limits you already have in mind.',
			businessDays: 2,
			questions: [
				{
					key: 'issues',
					label: 'What should the playbook cover, and what are your preferred positions?',
					required: true,
					kind: 'textarea'
				}
			]
		},
		{
			key: 'update-playbook',
			title: 'Update your playbook',
			description:
				'I’ll update your existing playbook to reflect changes to your contract, negotiation policy, or the issues your team is seeing in practice. Tell me what needs to change and why, including anything that should stay as it is. You can share supporting documents below.',
			businessDays: 2,
			questions: [
				{
					key: 'changes',
					label: 'What should I change, and why?',
					required: true,
					kind: 'textarea'
				}
			]
		}
	] satisfies Task[]
};
export const seedCatalog = internalMutation({
	args: {},
	returns: v.number(),
	handler: async (ctx) => {
		const existing = await ctx.db
			.query('delegationCatalog')
			.withIndex('by_key', (q) => q.eq('key', 'default'))
			.unique();
		if (
			existing &&
			canonical({ delegate: existing.delegate, tasks: existing.tasks }) ===
				canonical({ delegate: initialCatalog.delegate, tasks: initialCatalog.tasks })
		)
			return existing.revision;
		const revision = (existing?.revision ?? 0) + 1;
		if (existing)
			await ctx.db.replace('delegationCatalog', existing._id, { ...initialCatalog, revision });
		else await ctx.db.insert('delegationCatalog', { ...initialCatalog, revision });
		return revision;
	}
});
export const getCatalog = query({
	args: { membershipId: v.id('memberships'), refreshToken: v.optional(v.string()) },
	returns: v.union(catalog, v.null()),
	handler: async (ctx, { membershipId }) => {
		await admin(ctx, membershipId);
		const result = await ctx.db
			.query('delegationCatalog')
			.withIndex('by_key', (q) => q.eq('key', 'default'))
			.unique();
		return catalogSnapshot(result);
	}
});

function normalize(payload: Submission): Submission {
	identifier(payload.draftId);
	if (
		Object.keys(payload.answers).length > 20 ||
		payload.attachmentIds.length > ATTACHMENT_MAX_COUNT
	)
		invalid('Check your answers and attachments.');
	const answers = Object.fromEntries(
		Object.entries(payload.answers)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => {
				if (value.length > 10000) invalid('Keep each answer under 10,000 characters.');
				return [key, value.trim()];
			})
	);
	if (new Set(payload.attachmentIds).size !== payload.attachmentIds.length)
		invalid('An attachment was included twice.');
	return {
		draftId: payload.draftId,
		catalogRevision: payload.catalogRevision,
		taskKey: payload.taskKey,
		answers,
		attachmentIds: [...payload.attachmentIds].sort()
	};
}
export const submit = mutation({
	args: { membershipId: v.id('memberships'), operationId: v.string(), payload: submission },
	returns: submitted,
	handler: async (ctx, args) => {
		const access = await admin(ctx, args.membershipId);
		identifier(args.operationId);
		const operationId = scopedOperation(access, args.operationId);
		const payload = normalize(args.payload);
		const existing = await ctx.db
			.query('delegationRequests')
			.withIndex('by_operationId', (q) => q.eq('operationId', operationId))
			.unique();
		if (existing) {
			if (JSON.stringify(normalize(existing.payload)) !== JSON.stringify(payload))
				invalid('This submission ID has already been used for different answers.');
			return { requestId: existing._id, dueDate: existing.dueDate };
		}
		const current = await ctx.db
			.query('delegationCatalog')
			.withIndex('by_key', (q) => q.eq('key', 'default'))
			.unique();
		if (!current || current.revision !== payload.catalogRevision)
			throw new ConvexError({
				code: 'STALE_CATALOG',
				definitive: true,
				catalog: catalogSnapshot(current),
				message: 'The task details changed. Review your answers and continue again.'
			});
		const task = current.tasks.find((t) => t.key === payload.taskKey);
		if (!task) rejected('Select an available task.');
		if (Object.keys(payload.answers).some((key) => !task.questions.some((q) => q.key === key)))
			rejected('Review the questions for this task.');
		for (const question of task.questions) {
			if (question.required && !payload.answers[question.key])
				rejected(`Answer “${question.label}” before continuing.`);
		}
		const attachments: Extract<Doc<'delegationAttachments'>, { state: 'staged' }>[] = [];
		for (const id of payload.attachmentIds) {
			const file = await ctx.db.get('delegationAttachments', id);
			if (
				!file ||
				file.companyId !== access.companyId ||
				file.uploaderId !== access._id ||
				file.draftId !== payload.draftId ||
				file.state !== 'staged' ||
				file.expiresAt <= Date.now()
			)
				rejected('An attachment is unavailable. Remove it and upload it again.');
			const storage = await ctx.db.system.get('_storage', file.storageId);
			if (
				!storage ||
				storage.size !== file.size ||
				storage.size > ATTACHMENT_MAX_BYTES ||
				storage.contentType !== file.contentType ||
				![DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE].includes(file.contentType)
			)
				rejected('An attachment is unavailable. Remove it and upload it again.');
			attachments.push(file);
		}
		const submittedAt = Date.now();
		const dueDate = delegationDeadline(submittedAt, task.businessDays);
		const requestId = await ctx.db.insert('delegationRequests', {
			companyId: access.companyId,
			submitterId: access._id,
			operationId,
			payload,
			snapshot: { delegate: current.delegate, task },
			submittedAt,
			dueDate,
			timezone: DELEGATION_TIMEZONE
		});
		for (const file of attachments) {
			const { expiresAt: _expiresAt, _id, _creationTime: _time, ...fields } = file;
			await ctx.db.replace('delegationAttachments', _id, {
				...fields,
				state: 'submitted',
				requestId
			});
		}
		return { requestId, dueDate };
	}
});

export const draftAttachments = query({
	args: { membershipId: v.id('memberships'), draftId: v.string() },
	returns: v.array(draftAttachment),
	handler: async (ctx, { membershipId, draftId }) => {
		const access = await admin(ctx, membershipId);
		identifier(draftId);
		const files = await ctx.db
			.query('delegationAttachments')
			.withIndex('by_companyId_and_uploaderId_and_draftId_and_uploadId', (q) =>
				q.eq('companyId', access.companyId).eq('uploaderId', access._id).eq('draftId', draftId)
			)
			.take(ATTACHMENT_MAX_COUNT);
		return files.flatMap((file) =>
			file.state === 'staged'
				? [{ _id: file._id, uploadId: file.uploadId, expiresAt: file.expiresAt }]
				: []
		);
	}
});
async function checkCancellation(
	ctx: QueryCtx,
	access: { companyId: Id<'company'>; _id: Id<'profiles'> },
	draftId: string,
	uploadId: string
) {
	const markers = await Promise.all(
		[null, uploadId].map((id) =>
			ctx.db
				.query('delegationCancellations')
				.withIndex('by_companyId_and_uploaderId_and_draftId_and_uploadId', (q) =>
					q
						.eq('companyId', access.companyId)
						.eq('uploaderId', access._id)
						.eq('draftId', draftId)
						.eq('uploadId', id)
				)
				.unique()
		)
	);
	if (markers.some((marker) => marker && marker.expiresAt > Date.now()))
		invalid('This upload was cancelled. Select the file again.');
}
export const authorizeUpload = internalQuery({
	args: uploadArgs.fields,
	returns: v.null(),
	handler: async (ctx, args) => {
		const access = await admin(ctx, args.membershipId);
		identifier(args.draftId);
		identifier(args.uploadId);
		await checkCancellation(ctx, access, args.draftId, args.uploadId);
		return null;
	}
});
export const registerUpload = internalMutation({
	args: {
		...uploadArgs.fields,
		storageId: v.id('_storage'),
		filename: v.string(),
		registrationDeadline: v.number()
	},
	returns: registeredUpload,
	handler: async (ctx, args) => {
		const access = await admin(ctx, args.membershipId);
		identifier(args.draftId);
		identifier(args.uploadId);
		if (!Number.isFinite(args.registrationDeadline) || args.registrationDeadline <= Date.now())
			invalid('This upload expired. Try again.');
		await checkCancellation(ctx, access, args.draftId, args.uploadId);
		const storage = await ctx.db.system.get('_storage', args.storageId);
		if (
			!storage ||
			storage.size <= 0 ||
			storage.size > ATTACHMENT_MAX_BYTES ||
			![DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE].includes(storage.contentType ?? '') ||
			args.filename.length > 255
		)
			invalid('Choose a DOCX or PDF no larger than 10 MB.');
		const existing = await ctx.db
			.query('delegationAttachments')
			.withIndex('by_companyId_and_uploaderId_and_draftId_and_uploadId', (q) =>
				q
					.eq('companyId', access.companyId)
					.eq('uploaderId', access._id)
					.eq('draftId', args.draftId)
					.eq('uploadId', args.uploadId)
			)
			.unique();
		if (existing) {
			if (
				existing.filename !== args.filename ||
				existing.sha256 !== storage.sha256 ||
				existing.state !== 'staged' ||
				existing.expiresAt <= Date.now()
			)
				invalid('This upload is no longer available. Select the file again.');
			return { attachmentId: existing._id, storageId: existing.storageId };
		}
		const draft = await ctx.db
			.query('delegationAttachments')
			.withIndex('by_companyId_and_uploaderId_and_draftId_and_uploadId', (q) =>
				q.eq('companyId', access.companyId).eq('uploaderId', access._id).eq('draftId', args.draftId)
			)
			.take(ATTACHMENT_MAX_COUNT);
		// Expired rows must not consume a slot while the periodic sweep catches up.
		let count = 0;
		for (const file of draft) {
			if (file.state === 'submitted') invalid('Attach up to three documents to a task.');
			if (file.expiresAt <= Date.now()) await deleteStaged(ctx, file);
			else count++;
		}
		if (count >= ATTACHMENT_MAX_COUNT) invalid('Attach up to three documents to a task.');
		const id = await ctx.db.insert('delegationAttachments', {
			storageId: args.storageId,
			companyId: access.companyId,
			uploaderId: access._id,
			draftId: args.draftId,
			uploadId: args.uploadId,
			filename: args.filename,
			size: storage.size,
			contentType: storage.contentType!,
			sha256: storage.sha256,
			state: 'staged',
			expiresAt: Date.now() + UPLOAD_TTL
		});
		return { attachmentId: id, storageId: args.storageId };
	}
});
async function deleteStaged(ctx: MutationCtx, file: Doc<'delegationAttachments'>) {
	if (file.state !== 'staged') return;
	await ctx.storage.delete(file.storageId);
	await ctx.db.delete('delegationAttachments', file._id);
}
export const discard = mutation({
	args: {
		membershipId: v.id('memberships'),
		draftId: v.string(),
		uploadId: v.optional(v.string())
	},
	returns: v.null(),
	handler: async (ctx, { membershipId, draftId, uploadId }) => {
		const access = await admin(ctx, membershipId);
		identifier(draftId);
		if (uploadId !== undefined) identifier(uploadId);
		const scope = {
			companyId: access.companyId,
			uploaderId: access._id,
			draftId,
			uploadId: uploadId ?? null
		};
		const marker = await ctx.db
			.query('delegationCancellations')
			.withIndex('by_companyId_and_uploaderId_and_draftId_and_uploadId', (q) =>
				q
					.eq('companyId', scope.companyId)
					.eq('uploaderId', scope.uploaderId)
					.eq('draftId', draftId)
					.eq('uploadId', scope.uploadId)
			)
			.unique();
		const expiresAt = Date.now() + UPLOAD_TTL;
		if (marker) await ctx.db.patch('delegationCancellations', marker._id, { expiresAt });
		else await ctx.db.insert('delegationCancellations', { ...scope, expiresAt });
		const files = await ctx.db
			.query('delegationAttachments')
			.withIndex('by_companyId_and_uploaderId_and_draftId_and_uploadId', (q) => {
				const draft = q
					.eq('companyId', access.companyId)
					.eq('uploaderId', access._id)
					.eq('draftId', draftId);
				return uploadId === undefined ? draft : draft.eq('uploadId', uploadId);
			})
			.take(ATTACHMENT_MAX_COUNT);
		for (const file of files) await deleteStaged(ctx, file);
		return null;
	}
});
export const expireCancellations = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const markers = await ctx.db
			.query('delegationCancellations')
			.withIndex('by_expiresAt', (q) => q.lte('expiresAt', Date.now()))
			.take(25);
		for (const marker of markers) await ctx.db.delete('delegationCancellations', marker._id);
		if (markers.length === 25)
			await ctx.scheduler.runAfter(0, internal.delegation.expireCancellations, {});
		return null;
	}
});
export const expireAttachments = internalMutation({
	args: {},
	returns: v.null(),
	handler: async (ctx) => {
		const files = await ctx.db
			.query('delegationAttachments')
			.withIndex('by_state_and_expiresAt', (q) =>
				q.eq('state', 'staged').lte('expiresAt', Date.now())
			)
			.take(25);
		for (const file of files) await deleteStaged(ctx, file);
		if (files.length === 25)
			await ctx.scheduler.runAfter(0, internal.delegation.expireAttachments, {});
		return null;
	}
});
