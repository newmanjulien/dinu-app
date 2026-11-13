import { contractDocumentFromRenderTransport } from '$lib/document/contract-document';
import { ConvexHttpClient } from 'convex/browser';
import { env } from '$env/dynamic/public';
import { api } from '../../../../../convex/_generated/api';
import { contractName } from '$lib/contract/filename';
import { composeExport } from '$lib/document/export/content';
import { generateWord } from '$lib/server/document/export/word';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ params, request }) => {
	const noStore = { 'Cache-Control': 'private, no-store' };
	try {
		const body: unknown = await request.json().catch(() => null);
		if (
			!body ||
			typeof body !== 'object' ||
			!('displayIdentity' in body) ||
			typeof body.displayIdentity !== 'string' ||
			!/^[a-f0-9]{64}$/u.test(body.displayIdentity)
		)
			return new Response('The displayed contract identity is required.', {
				status: 400,
				headers: noStore
			});
		const displayIdentity = body.displayIdentity;
		if (!env.PUBLIC_CONVEX_URL)
			return new Response('Download unavailable.', { status: 503, headers: noStore });
		const client = new ConvexHttpClient(env.PUBLIC_CONVEX_URL);
		const snapshot = await client.query(api.buyerLinks.currentDocument, { token: params.token });
		if (snapshot.displayIdentity !== displayIdentity)
			return new Response(
				'The displayed contract changed. Review the current contract and try again.',
				{ status: 409, headers: noStore }
			);
		const blob = await generateWord(
			composeExport({ document: contractDocumentFromRenderTransport(snapshot.document) }),
			contractName(snapshot.title)
		);
		const bytes = await blob.arrayBuffer();
		// A fresh client cannot reuse a timestamp pinned by an earlier content read.
		await new ConvexHttpClient(env.PUBLIC_CONVEX_URL).query(api.buyerLinks.authorizeDownload, {
			token: params.token,
			displayIdentity
		});
		return new Response(bytes, {
			headers: {
				'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
				'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${contractName(snapshot.title)}.docx`)}`,
				'Cache-Control': 'private, no-store'
			}
		});
	} catch {
		return new Response(
			'This download is unavailable. Review the current contract and try again.',
			{
				status: 409,
				headers: { 'Cache-Control': 'private, no-store' }
			}
		);
	}
};
