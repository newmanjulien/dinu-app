import { ConvexError, getDocumentSize, type Infer } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { CompanyAccess } from './auth';
import { hubspotKind } from './hubspotValidators';

export function operation(value: string) {
	if (!value.trim() || value.length > 200) throw new ConvexError('Invalid operation identity.');
}
export async function receipt(ctx: QueryCtx, key: string, inputs: string) {
	let row = await ctx.db
		.query('hubspotReceipts')
		.withIndex('by_key', (q) => q.eq('key', key))
		.unique();
	if (row?.chunked) {
		const chunks = await ctx.db
			.query('hubspotReceiptChunks')
			.withIndex('by_receiptId_and_order', (q) => q.eq('receiptId', row!._id))
			.take(64);
		if (chunks.length === 64) throw new Error('Receipt exceeds its storage envelope.');
		const [originalInputs, result] = JSON.parse(chunks.map((c) => c.data).join('')) as [
			string,
			string
		];
		row = { ...row, inputs: originalInputs, result };
	}
	if (row && row.inputs !== inputs)
		throw new ConvexError('This operation was already used with different inputs.');
	return row;
}
export async function remember(
	ctx: MutationCtx,
	companyId: Doc<'company'>['_id'],
	key: string,
	inputs: string,
	result: string
) {
	const chunked = getDocumentSize({ companyId, key, inputs, result }) > 128 * 1024;
	const id = await ctx.db.insert('hubspotReceipts', {
		companyId,
		key,
		inputs: chunked ? '' : inputs,
		result: chunked ? '' : result,
		...(chunked ? { chunked: true } : {})
	});
	if (chunked) {
		const data = JSON.stringify([inputs, result]);
		if (data.length > 63 * 48 * 1024) throw new Error('Receipt exceeds its storage envelope.');
		for (let offset = 0, order = 0; offset < data.length; offset += 48 * 1024, order++)
			await ctx.db.insert('hubspotReceiptChunks', {
				companyId,
				receiptId: id,
				order,
				data: data.slice(offset, offset + 48 * 1024)
			});
	}
}
export function actorOf(profile: Pick<Doc<'profiles'>, 'name' | 'email'>) {
	return { name: profile.name, email: profile.email };
}
export async function activity(
	ctx: MutationCtx,
	contract: Pick<Doc<'savedContracts'>, '_id' | 'companyId' | 'buyerCompanyName' | 'hubspot'>,
	actor: ReturnType<typeof actorOf>,
	key: string,
	kind: Infer<typeof hubspotKind>,
	detail = '',
	occurredAt = Date.now(),
	attemptId?: Doc<'hubspotExports'>['_id']
) {
	if (!contract.hubspot) return;
	if (
		await ctx.db
			.query('hubspotEvents')
			.withIndex('by_key', (q) => q.eq('key', key))
			.unique()
	)
		return;
	const { availability: _availability, ...destination } = contract.hubspot;
	// Rendered details are bounded independently of immutable reference chunks/receipts.
	let bounded = detail;
	if (new TextEncoder().encode(bounded).length > 48 * 1024) {
		try {
			const parsed = JSON.parse(detail);
			bounded = JSON.stringify({
				...parsed,
				description:
					typeof parsed.description === 'string' ? parsed.description.slice(0, 8000) : undefined,
				abbreviated: true
			});
		} catch {
			bounded = detail.slice(0, 8000);
		}
	}
	await ctx.db.insert('hubspotEvents', {
		companyId: contract.companyId,
		contractId: contract._id,
		destination,
		key,
		kind,
		title: contract.buyerCompanyName,
		actor,
		occurredAt,
		detail: bounded,
		attemptId,
		status:
			contract.hubspot.availability === 'unavailable' ||
			(attemptId && (await linkBlocked(ctx, contract._id, contract.hubspot.generation)))
				? 'paused'
				: 'pending',
		dueAt: Date.now(),
		tries: 0
	});
}
export function actionKey(access: CompanyAccess, kind: string, id: string) {
	operation(id);
	return JSON.stringify([access.membershipId, kind, id]);
}
export async function sha256(value: string) {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
		(b) => b.toString(16).padStart(2, '0')
	).join('');
}

export function linkBlocked(
	ctx: QueryCtx,
	contractId: Doc<'savedContracts'>['_id'],
	generation: number
) {
	return ctx.db
		.query('hubspotLinkBlocks')
		.withIndex('by_contractId_and_generation', (q) =>
			q.eq('contractId', contractId).eq('generation', generation)
		)
		.unique();
}
export async function blockLink(
	ctx: MutationCtx,
	companyId: Doc<'company'>['_id'],
	contractId: Doc<'savedContracts'>['_id'],
	generation: number
) {
	if (!(await linkBlocked(ctx, contractId, generation)))
		await ctx.db.insert('hubspotLinkBlocks', { companyId, contractId, generation });
}
