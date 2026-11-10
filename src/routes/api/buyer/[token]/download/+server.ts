import { releasedRecord } from '$lib/contract/released-selections';
import { ConvexHttpClient } from 'convex/browser';
import { env } from '$env/dynamic/public';
import { api } from '../../../../../convex/_generated/api';
import { contractName } from '$lib/contract/filename';
import { composeExport } from '$lib/document/export/content';
import { generateWord } from '$lib/server/document/export/word';
import { documentAnnotations } from '$lib/playbook/document-overlay';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ params, request }) => {
	try {
		if (!env.PUBLIC_CONVEX_URL) return new Response('Download unavailable.', { status: 503 });
		const client = new ConvexHttpClient(env.PUBLIC_CONVEX_URL);
		const body: unknown = await request.json();
		if (
			!body ||
			typeof body !== 'object' ||
			!('buyerRevision' in body) ||
			!Number.isSafeInteger(body.buyerRevision)
		)
			return new Response('Invalid revision.', { status: 400 });
		const snapshot = await client.query(api.buyerLinks.content, { token: params.token });
		if (snapshot.buyerRevision !== body.buyerRevision)
			return new Response('Downloading is unavailable for this version.', { status: 409 });
		const items = snapshot.items.map((item) => ({
			...item,
			annotations: documentAnnotations({ _id: item.itemId, ...item })
		}));
		const blob = await generateWord(
			composeExport({
				blocks: snapshot.blocks,
				items,
				activeConcessions: releasedRecord(snapshot.selections)
			}),
			contractName(snapshot.title)
		);
		const bytes = await blob.arrayBuffer();
		// A fresh client cannot reuse a timestamp pinned by an earlier content read.
		await new ConvexHttpClient(env.PUBLIC_CONVEX_URL).query(api.buyerLinks.authorizeDownload, {
			token: params.token,
			buyerRevision: snapshot.buyerRevision
		});
		return new Response(bytes, {
			headers: {
				'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${contractName(snapshot.title)}.docx`)}`,
				'Cache-Control': 'private, no-store'
			}
		});
	} catch {
		return new Response('This download is unavailable. Open the latest link and try again.', {
			status: 409,
			headers: { 'Cache-Control': 'private, no-store' }
		});
	}
};
