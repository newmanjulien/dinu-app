import { ConvexError } from 'convex/values';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { ATTACHMENT_MAX_BYTES, DOCX_CONTENT_TYPE, PDF_CONTENT_TYPE } from '../lib/delegation';

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
// Inspect ZIP directory names without inflating or importing document content.
function isDocx(bytes: Uint8Array): boolean {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) return false;
	for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
		if (view.getUint32(offset, true) !== 0x06054b50) continue;
		const count = view.getUint16(offset + 10, true);
		let cursor = view.getUint32(offset + 16, true);
		if (count > 2000) return false;
		const names = new Set<string>();
		for (let i = 0; i < count; i++) {
			if (cursor + 46 > offset || view.getUint32(cursor, true) !== 0x02014b50) return false;
			const nameLength = view.getUint16(cursor + 28, true);
			const next =
				cursor +
				46 +
				nameLength +
				view.getUint16(cursor + 30, true) +
				view.getUint16(cursor + 32, true);
			if (next > offset) return false;
			names.add(new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)));
			cursor = next;
		}
		return names.has('[Content_Types].xml') && names.has('word/document.xml');
	}
	return false;
}
export const upload = httpAction(async (ctx, request) => {
	const registrationDeadline = Date.now() + 10 * 60_000;
	try {
		if (!(await ctx.auth.getUserIdentity())) return response({ error: 'Sign in required.' }, 401);
		const params = new URL(request.url).searchParams;
		const membershipId = params.get('membershipId') as Id<'memberships'> | null;
		const draftId = params.get('draftId') ?? '';
		const uploadId = params.get('uploadId') ?? '';
		const filename = params.get('filename') ?? '';
		if (!membershipId) return response({ error: 'Company access is required.' }, 403);
		await ctx.runQuery(internal.delegation.authorizeUpload, { membershipId, draftId, uploadId });
		const contentType = /\.docx$/i.test(filename)
			? DOCX_CONTENT_TYPE
			: /\.pdf$/i.test(filename)
				? PDF_CONTENT_TYPE
				: null;
		if (
			!contentType ||
			filename.length > 255 ||
			request.headers.get('content-type')?.split(';')[0].trim() !== contentType
		)
			return response({ error: 'Choose a DOCX or PDF document.' }, 400);
		if (Number(request.headers.get('content-length')) > ATTACHMENT_MAX_BYTES)
			return response({ error: 'Choose a document no larger than 10 MB.' }, 413);
		const reader = request.body?.getReader();
		if (!reader) return response({ error: 'The document is empty.' }, 400);
		const chunks: Uint8Array<ArrayBuffer>[] = [];
		let size = 0;
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				size += chunk.value.byteLength;
				if (size > ATTACHMENT_MAX_BYTES) {
					await reader.cancel();
					return response({ error: 'Choose a document no larger than 10 MB.' }, 413);
				}
				chunks.push(chunk.value);
			}
		} finally {
			reader.releaseLock();
		}
		const blob = new Blob(chunks, { type: contentType });
		const bytes = new Uint8Array(
			await (contentType === PDF_CONTENT_TYPE ? blob.slice(0, 8) : blob).arrayBuffer()
		);
		const valid =
			contentType === DOCX_CONTENT_TYPE
				? isDocx(bytes)
				: /^%PDF-\d\.\d/.test(new TextDecoder().decode(bytes.subarray(0, 8)));
		if (!size || !valid)
			return response({ error: 'This file is not a valid DOCX or PDF document.' }, 400);
		const storageId = await ctx.storage.store(blob);
		let registeredStorageId: Id<'_storage'> | undefined;
		try {
			const attachment = await ctx.runMutation(internal.delegation.registerUpload, {
				membershipId,
				draftId,
				uploadId,
				storageId,
				filename,
				registrationDeadline
			});
			registeredStorageId = attachment.storageId;
			return response({ attachmentId: attachment.attachmentId });
		} finally {
			// Failed/uncertain registration and duplicate storage need reference-aware cleanup.
			if (registeredStorageId !== storageId)
				try {
					await ctx.scheduler.runAfter(0, internal.baselineUploads.discardFile, {
						fileId: storageId
					});
				} catch (error) {
					console.error('Unable to dispatch delegation upload cleanup.', error);
				}
		}
	} catch (error) {
		if (error instanceof ConvexError) {
			const data = error.data;
			return response(
				{
					error:
						typeof data === 'string'
							? data
							: data && typeof data === 'object' && 'message' in data
								? String(data.message)
								: 'Unable to upload this document.'
				},
				409
			);
		}
		console.error('Unable to upload delegation attachment.', error);
		return response({ error: 'Unable to upload this document. Try again.' }, 500);
	}
});
export const preflight = httpAction(async () => new Response(null, { status: 204, headers: cors }));
