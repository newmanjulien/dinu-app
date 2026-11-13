import { v } from 'convex/values';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { internalMutation } from './_generated/server';
import { constructionOwned, nativeOwnerArgs } from './nativeConstruction';
import { admitDiscussionWork } from './discussionMaps';
import { receiptChunkFingerprint } from './operationReceipts';
import { documentBytes } from './storageCapacity';
import { storedContractChange } from './contractChangeValidators';
import schema from './schema';
import { canonicalJson } from '../lib/document/canonical-json';

const digest = (bytes: ArrayBuffer) => bytesToHex(sha256(new Uint8Array(bytes)));
const slot = v.union(v.literal('reverse'), v.literal('candidate'), v.literal('comparison'));
export const beginDocument = internalMutation({
	args: {
		...nativeOwnerArgs,
		slot,
		fingerprint: v.string(),
		hashes: v.array(v.string()),
		dataBytes: v.number(),
		blockCount: v.number()
	},
	returns: v.union(v.null(), schema.doc('contractDocuments')),
	handler: async (ctx, args) => {
		const state = await constructionOwned(ctx, args);
		if (!state?.native.build) return null;
		if (
			args.hashes.length < 1 ||
			args.hashes.length > 512 ||
			args.dataBytes > 16 * 1024 * 1024 ||
			receiptChunkFingerprint(JSON.stringify(args.hashes)) !== args.fingerprint
		)
			throw new Error('Invalid native document upload manifest.');
		const previous = await ctx.db
			.query('contractDocuments')
			.withIndex('by_stage_receiptId_generation_unit_slot', (q) =>
				q
					.eq('stage.receiptId', args.receiptId)
					.eq('stage.generation', args.generation)
					.eq('stage.unit', args.unit)
					.eq('stage.slot', args.slot)
			)
			.unique();
		if (previous) {
			if (
				previous.fingerprint !== args.fingerprint ||
				previous.dataBytes !== args.dataBytes ||
				previous.blockCount !== args.blockCount
			)
				throw new Error('Native document upload changed.');
			return previous;
		}
		await admitDiscussionWork(ctx, { writes: 1, bytes: 128 * 1024 });
		const id = await ctx.db.insert('contractDocuments', {
			companyId: state.row.companyId,
			contractId: state.contract.root._id,
			format: 1,
			fingerprint: args.fingerprint,
			chunkHashes: args.hashes,
			chunkIds: [],
			dataBytes: args.dataBytes,
			readBytes: 0,
			blockCount: args.blockCount,
			stage: {
				receiptId: args.receiptId,
				generation: args.generation,
				unit: args.unit,
				slot: args.slot,
				sealed: false,
				written: 0
			}
		});
		return ctx.db.get('contractDocuments', id);
	}
});
export const appendDocument = internalMutation({
	args: {
		...nativeOwnerArgs,
		documentId: v.id('contractDocuments'),
		offset: v.number(),
		chunks: v.array(v.bytes())
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const state = await constructionOwned(ctx, args);
		if (!state) return false;
		const row = await ctx.db.get('contractDocuments', args.documentId),
			stage = row?.stage;
		if (
			!row ||
			!stage ||
			stage.receiptId !== args.receiptId ||
			stage.generation !== args.generation ||
			stage.unit !== args.unit ||
			row.companyId !== state.row.companyId ||
			row.contractId !== state.contract.root._id
		)
			throw new Error('Native document upload owner changed.');
		if (
			args.chunks.length < 1 ||
			args.chunks.length > 4 ||
			args.chunks.some((chunk) => chunk.byteLength > 128 * 1024) ||
			!Number.isSafeInteger(args.offset) ||
			args.offset < 0 ||
			args.offset + args.chunks.length > row.chunkHashes.length
		)
			throw new Error('Invalid native document upload page.');
		if (args.chunks.some((chunk, i) => digest(chunk) !== row.chunkHashes[args.offset + i]))
			throw new Error('Native document upload hash changed.');
		if (args.offset < stage.written) {
			if (args.offset + args.chunks.length > stage.written)
				throw new Error('Native document upload is not contiguous.');
			return true;
		}
		if (stage.sealed || stage.written !== args.offset)
			throw new Error('Native document upload cursor changed.');
		await admitDiscussionWork(ctx, {
			writes: args.chunks.length + 1,
			bytes: args.chunks.reduce((n, c) => n + c.byteLength + 512, 0) + 128 * 1024
		});
		const ids = [...row.chunkIds];
		let readBytes = row.readBytes;
		for (const data of args.chunks) {
			const value = {
				companyId: row.companyId,
				contractId: row.contractId,
				fingerprint: digest(data),
				data
			};
			const id = await ctx.db.insert('contractDocumentChunks', value);
			ids.push(id);
			readBytes += documentBytes({ ...value, _id: id, _creationTime: 0 });
		}
		const written = stage.written + args.chunks.length,
			bytesWritten = (stage.bytes ?? 0) + args.chunks.reduce((n, chunk) => n + chunk.byteLength, 0);
		if (written === row.chunkHashes.length) {
			const bytes = await Promise.all(
				ids.slice(-args.chunks.length).map((id) => ctx.db.get('contractDocumentChunks', id))
			);
			if (bytes.some((chunk) => !chunk))
				throw new Error('Native uploaded document page disappeared.');
		}
		if (written === row.chunkHashes.length && bytesWritten !== row.dataBytes)
			throw new Error('Native document upload bytes changed.');
		await ctx.db.patch('contractDocuments', row._id, {
			chunkIds: ids,
			readBytes,
			stage: { ...stage, written, bytes: bytesWritten, sealed: written === row.chunkHashes.length }
		});
		return true;
	}
});
export const beginChange = internalMutation({
	args: { ...nativeOwnerArgs, row: storedContractChange, hashes: v.array(v.string()) },
	returns: v.union(v.null(), schema.doc('contractChanges')),
	handler: async (ctx, args) => {
		const state = await constructionOwned(ctx, args);
		if (!state?.native.build || !state.access) return null;
		const b = state.native.build;
		if (
			b.phase !== 'patch' ||
			args.row.companyId !== state.row.companyId ||
			args.row.contractId !== state.contract.root._id ||
			args.row.kind !== (state.row.kind === 'playbook-save' ? 'playbook' : 'buyer-proposal') ||
			args.row.stage ||
			args.row.chunks < 1 ||
			args.row.chunks > 64 ||
			args.row.dataBytes > 8_000_000 ||
			args.hashes.length !== args.row.chunks
		)
			throw new Error('Invalid native change upload.');
		const previous = await ctx.db
			.query('contractChanges')
			.withIndex('by_stage_receiptId_generation_unit_slot', (q) =>
				q
					.eq('stage.receiptId', args.receiptId)
					.eq('stage.generation', args.generation)
					.eq('stage.unit', args.unit)
					.eq('stage.slot', 'patch')
			)
			.unique();
		if (previous) {
			const { stage: _stage, _id: _id, _creationTime: _time, ...stored } = previous;
			if (
				canonicalJson(stored) !== canonicalJson(args.row) ||
				canonicalJson(previous.stage!.hashes) !== canonicalJson(args.hashes)
			)
				throw new Error('Native patch upload changed.');
			return previous;
		}
		await admitDiscussionWork(ctx, { writes: 1, bytes: 128 * 1024 });
		const id = await ctx.db.insert('contractChanges', {
			...args.row,
			stage: {
				receiptId: args.receiptId,
				generation: args.generation,
				unit: args.unit,
				slot: 'patch',
				sealed: false,
				written: 0,
				hashes: args.hashes,
				fingerprint: receiptChunkFingerprint(JSON.stringify(args.hashes)),
				bytes: 0
			}
		});
		return ctx.db.get('contractChanges', id);
	}
});
export const appendChange = internalMutation({
	args: {
		...nativeOwnerArgs,
		changeId: v.id('contractChanges'),
		offset: v.number(),
		parts: v.array(v.string())
	},
	returns: v.boolean(),
	handler: async (ctx, args) => {
		const state = await constructionOwned(ctx, args);
		if (!state) return false;
		const row = await ctx.db.get('contractChanges', args.changeId),
			stage = row?.stage;
		if (
			!row ||
			!stage ||
			stage.receiptId !== args.receiptId ||
			stage.generation !== args.generation ||
			stage.unit !== args.unit ||
			row.companyId !== state.row.companyId ||
			row.contractId !== state.contract.root._id
		)
			throw new Error('Native patch upload ownership failed.');
		if (
			args.parts.length < 1 ||
			args.parts.length > 4 ||
			args.parts.some((part) => part.length > 120 * 1024 + 1) ||
			args.offset + args.parts.length > row.chunks
		)
			throw new Error('Invalid native patch upload page.');
		if (
			args.parts.some(
				(part, i) => receiptChunkFingerprint(part) !== stage.hashes?.[args.offset + i]
			)
		)
			throw new Error('Native patch upload hash changed.');
		if (args.offset < stage.written) {
			for (const [i, data] of args.parts.entries()) {
				const chunk = await ctx.db
					.query('contractChangeContents')
					.withIndex('by_changeId_and_order', (q) =>
						q.eq('changeId', row._id).eq('order', args.offset + i)
					)
					.unique();
				if (!chunk || chunk.data !== data) throw new Error('Native patch upload retry changed.');
			}
			return true;
		}
		if (
			!Number.isSafeInteger(args.offset) ||
			args.offset < 0 ||
			stage.sealed ||
			stage.written !== args.offset
		)
			throw new Error('Native patch upload cursor changed.');
		await admitDiscussionWork(ctx, {
			writes: args.parts.length + 1,
			bytes: args.parts.reduce((n, s) => n + new TextEncoder().encode(s).length + 512, 0)
		});
		for (const [i, data] of args.parts.entries())
			await ctx.db.insert('contractChangeContents', {
				companyId: row.companyId,
				contractId: row.contractId,
				changeId: row._id,
				order: args.offset + i,
				data
			});
		const written = stage.written + args.parts.length,
			bytesWritten =
				(stage.bytes ?? 0) +
				args.parts.reduce((n, part) => n + new TextEncoder().encode(part).length, 0);
		if (written === row.chunks && bytesWritten !== row.dataBytes)
			throw new Error('Native patch upload bytes changed.');
		await ctx.db.patch('contractChanges', row._id, {
			stage: { ...stage, written, bytes: bytesWritten, sealed: written === row.chunks }
		});
		return true;
	}
});
