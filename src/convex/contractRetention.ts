import { internal } from './_generated/api';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { assertContractDocumentManifest } from './contractDocuments';
import { outputReservation, initialProofCursor, foldOutputProofPage } from './outputProof';
import { receiptPayload, sealReceipt } from './operationReceipts';
import { retireOutputPreparation } from './outputReservations';
import { cancelJob } from './emailDeliveries';
import { retireSnapshotDelivery } from './emailDisposal';
import { documentBytes } from './storageCapacity';
const hash = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
const encoder = new TextEncoder();

export async function retainedProvider(ctx: QueryCtx, id: Id<'hubspotQuotePushes'>) {
	return Boolean(
		await ctx.db
			.query('contractOutputs')
			.withIndex('by_providerOperationId', (q) => q.eq('providerOperationId', id))
			.first()
	);
}
/** Current views, immutable outputs and active native stages own document reachability. */
export async function retainedDocument(ctx: QueryCtx, id: Id<'contractDocuments'>) {
	const document = await ctx.db.get('contractDocuments', id);
	if (!document) return false;
	const root = await ctx.db.get('savedContracts', document.contractId);
	if (root?.companyId === document.companyId && root.documentId === id) return true;
	const link = await ctx.db
		.query('buyerLinks')
		.withIndex('by_contractId', (q) => q.eq('contractId', document.contractId))
		.first();
	if (link?.companyId === document.companyId && link.currentView?.documentId === id) return true;
	if (
		(await ctx.db
			.query('operationReceipts')
			.withIndex('by_documentId', (q) => q.eq('documentId', id))
			.first()) ||
		(await ctx.db
			.query('contractOutputs')
			.withIndex('by_documentId', (q) => q.eq('documentId', id))
			.first())
	)
		return true;
	if (document.stage) {
		const owner = await ctx.db.get('operationReceipts', document.stage.receiptId);
		if (
			owner?.state === 'preparing' &&
			owner.companyId === document.companyId &&
			owner.contractId === document.contractId &&
			owner.preparation?.native?.generation === document.stage.generation
		)
			return true;
	}
	return false;
}
/** Invalidate the exact original pending owner before source retirement. Its replay fence survives. */
export async function retirePendingOperation(
	ctx: MutationCtx,
	row: Doc<'operationReceipts'>,
	reason = 'This contract was deleted.'
) {
	if (row.outputId) {
		const output = await ctx.db.get('contractOutputs', row.outputId);
		if (output && (output.companyId !== row.companyId || output.contractId !== row.contractId))
			throw new Error('Pending output owner changed.');
		if (output?.format === 'full' && (output.outputPreparation || output.state === 'preparing')) {
			await retireOutputPreparation(ctx, output, reason);
			if (row.state === 'preparing') return;
		}
	}
	await cancelJob(ctx, row.preparation?.native?.jobId);
	await cancelJob(ctx, row.preparation?.passageJobId);
	if (row.emailPreparation) {
		const delivery = await ctx.db.get('emailDeliveries', row.emailPreparation.deliveryId);
		if (delivery) {
			if (
				delivery.companyId !== row.companyId ||
				!('contractId' in delivery) ||
				!('snapshot' in delivery) ||
				delivery.contractId !== row.contractId ||
				delivery.snapshot?.generation !== row.emailPreparation.generation
			)
				throw new Error('Pending email owner changed.');
			await retireSnapshotDelivery(ctx, delivery);
		}
	}
	if (row.state === 'preparing') {
		const payload = await receiptPayload(ctx, row);
		await sealReceipt(ctx, row, payload.inputs, {
			state: 'failed',
			error: reason
		});
	}
	if (row.emailPreparation || (row.state === 'preparing' && row.documentId))
		await ctx.db.patch('operationReceipts', row._id, {
			emailPreparation: undefined,
			...(row.state === 'preparing' ? { documentId: undefined } : {})
		});
}
async function ownerManifest(
	ctx: QueryCtx,
	marker: Doc<'contractCleanups'>,
	outputId: Id<'contractOutputs'>,
	documentId?: Id<'contractDocuments'>
) {
	const row = await ctx.db.get('contractOutputs', outputId);
	if (row?.format !== 'full' || !row.documentId || (documentId && row.documentId !== documentId))
		throw new Error('Retained output owner has no document.');
	return outputReservation(ctx, {
		companyId: marker.companyId,
		contractId: marker.contractId,
		outputId,
		documentId: row.documentId
	});
}
async function beginProof(
	ctx: MutationCtx,
	marker: Doc<'contractCleanups'>,
	outputId: Id<'contractOutputs'>,
	documentId?: Id<'contractDocuments'>
) {
	const { reservationManifest } = await ownerManifest(ctx, marker, outputId, documentId);
	await ctx.db.patch('contractCleanups', marker._id, {
		retentionProof: {
			outputId,
			section: reservationManifest.proof.section,
			generation: reservationManifest.proof.generation,
			cursor: initialProofCursor(reservationManifest.proof)
		}
	});
}
/** Complete all output proof and document/chunk integrity folds before any original source drain. */
export async function prepareRetention(ctx: MutationCtx, marker: Doc<'contractCleanups'>) {
	if (marker.retentionComplete) return true;
	if (marker.retentionDocumentId) {
		const document = await ctx.db.get('contractDocuments', marker.retentionDocumentId);
		assertContractDocumentManifest(document, {
			companyId: marker.companyId,
			contractId: marker.contractId
		});
		let offset = marker.retentionChunkOffset ?? 0,
			bytes = marker.retentionBytes ?? 0,
			readBytes = marker.retentionReadBytes ?? 0;
		for (let count = 0; count < 4 && offset < document.chunkIds.length; count++, offset++) {
			const chunk = await ctx.db.get('contractDocumentChunks', document.chunkIds[offset]);
			if (
				!chunk ||
				chunk.companyId !== marker.companyId ||
				chunk.contractId !== marker.contractId ||
				chunk.fingerprint !== document.chunkHashes[offset] ||
				hash(new Uint8Array(chunk.data)) !== chunk.fingerprint
			)
				throw new Error('Retained output document chunks are incomplete or corrupt.');
			bytes += chunk.data.byteLength;
			readBytes += documentBytes(chunk);
		}
		const complete = offset === document.chunkIds.length;
		if (
			complete &&
			(bytes !== document.dataBytes ||
				readBytes !== document.readBytes ||
				hash(encoder.encode(JSON.stringify(document.chunkHashes))) !== document.fingerprint)
		)
			throw new Error('Retained output document does not match its seal.');
		await ctx.db.patch('contractCleanups', marker._id, {
			retentionDocumentId: complete ? undefined : document._id,
			retentionChunkOffset: complete ? undefined : offset,
			retentionBytes: complete ? undefined : bytes,
			retentionReadBytes: complete ? undefined : readBytes
		});
		return false;
	}
	if (marker.retentionProof) {
		const proof = marker.retentionProof,
			{ reservationManifest } = await ownerManifest(ctx, marker, proof.outputId);
		if (
			proof.section !== reservationManifest.proof.section ||
			proof.generation !== reservationManifest.proof.generation
		)
			throw new Error('Retained proof owner changed during preflight.');
		const result = await foldOutputProofPage(ctx, reservationManifest, proof.cursor);
		if (result.complete) {
			const document = await ctx.db.get('contractDocuments', reservationManifest.documentId);
			assertContractDocumentManifest(document, {
				companyId: marker.companyId,
				contractId: marker.contractId
			});
			if (document.fingerprint !== reservationManifest.documentFingerprint)
				throw new Error('Retained document differs from its immutable reservation.');
			await ctx.db.patch('contractCleanups', marker._id, {
				retentionProof: undefined,
				retentionDocumentId: document._id,
				retentionChunkOffset: 0,
				retentionBytes: 0,
				retentionReadBytes: 0
			});
		} else
			await ctx.db.patch('contractCleanups', marker._id, {
				retentionProof: { ...proof, cursor: result.cursor }
			});
		return false;
	}
	if (marker.retentionOwnersDone) {
		await ctx.db.patch('contractCleanups', marker._id, { retentionComplete: true });
		return false;
	}
	const phase = marker.retentionPhase ?? 'receipts',
		pagination = {
			cursor: marker.retentionCursor ?? null,
			numItems: 1,
			maximumRowsRead: 1,
			maximumBytesRead: 1024 * 1024
		};
	let next: typeof phase | undefined, done: boolean, cursor: string;
	if (phase === 'receipts') {
		const page = await ctx.db
			.query('operationReceipts')
			.withIndex('by_contractId', (q) => q.eq('contractId', marker.contractId))
			.paginate(pagination);
		for (const row of page.page) {
			if (row.companyId !== marker.companyId) throw new Error('Retained receipt company changed.');
			if (row.state === 'preparing' || row.emailPreparation) {
				await retirePendingOperation(ctx, row);
				return false;
			}
			if ((await ctx.runMutation(internal.nativeConstructionCleanup.dispose, { receiptId: row._id })) !== 'ready') return false;
		}
		({ continueCursor: cursor, isDone: done } = page);
		next = 'outputs';
	} else if (phase === 'outputs') {
		const page = await ctx.db
			.query('contractOutputs')
			.withIndex('by_contractId', (q) => q.eq('contractId', marker.contractId))
			.paginate(pagination);
		for (const row of page.page) {
			if (row.companyId !== marker.companyId) throw new Error('Retained output company changed.');
			if (row.format !== 'full' || row.compaction || row.disposal) continue;
			if (row.outputPreparation || row.state === 'preparing') {
				await retireOutputPreparation(ctx, row, 'This contract was deleted.');
				return false;
			}
			if (row.reservationManifest) await beginProof(ctx, marker, row._id);
			if (row.providerOperationId) {
				const push = await ctx.db.get('hubspotQuotePushes', row.providerOperationId);
				if (!push || push.companyId !== marker.companyId || push.contractId !== marker.contractId)
					throw new Error('Retained output has no valid provider observation.');
			}
		}
		({ continueCursor: cursor, isDone: done } = page);
		next = 'attempts';
	} else if (phase === 'attempts') {
		const page = await ctx.db
			.query('hubspotExports')
			.withIndex('by_contractId', (q) => q.eq('contractId', marker.contractId))
			.paginate(pagination);
		for (const row of page.page) {
			if (row.companyId !== marker.companyId) throw new Error('Retained attempt company changed.');
			if (row.format === 'full') {
				const output = await ctx.db.get('contractOutputs', row.outputId);
				if (
					output?.format !== 'full' ||
					output.companyId !== row.companyId ||
					output.contractId !== row.contractId
				)
					throw new Error('Full retained attempt has no full output owner.');
				if (output?.format === 'full' && !output.compaction && !output.disposal)
					await beginProof(ctx, marker, row.outputId, row.documentId);
			}
		}
		({ continueCursor: cursor, isDone: done } = page);
		next = 'providers';
	} else {
		const page = await ctx.db
			.query('hubspotQuotePushes')
			.withIndex('by_contractId', (q) => q.eq('contractId', marker.contractId))
			.paginate(pagination);
		for (const row of page.page) {
			if (row.companyId !== marker.companyId) throw new Error('Retained push company changed.');
			if (row.format === 'full') {
				const output = await ctx.db.get('contractOutputs', row.outputId);
				if (
					output?.format !== 'full' ||
					output.companyId !== row.companyId ||
					output.contractId !== row.contractId
				)
					throw new Error('Full retained provider has no full output owner.');
				if (output?.format === 'full' && !output.compaction && !output.disposal)
					await beginProof(ctx, marker, row.outputId, row.documentId);
			}
		}
		({ continueCursor: cursor, isDone: done } = page);
	}
	// A final owner still has a proof/document fold. Mark completion only on the next turn.
	await ctx.db.patch('contractCleanups', marker._id, {
		retentionPhase: done ? (next ?? phase) : phase,
		retentionCursor: done ? undefined : cursor,
		retentionOwnersDone: done && !next ? true : undefined
	});
	return false;
}
