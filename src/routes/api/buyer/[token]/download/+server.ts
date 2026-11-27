import { ConvexHttpClient } from 'convex/browser';
import { env } from '$env/dynamic/public';
import { api } from '../../../../../convex/_generated/api';
import { contractName } from '$lib/contract/filename';
import { composeExport } from '$lib/document/export/content';
import { toAppliedOverlayItems } from '$lib/playbook/document-overlay';
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
		let snapshot = await client.query(api.buyerLinks.downloadSnapshot, {
			token: params.token,
			displayIdentity
		});
		if (snapshot.kind === 'too-large') {
			const state = await client.query(api.buyerLinks.currentState, { token: params.token });
			if (state.displayIdentity !== displayIdentity)
				return new Response(
					'The displayed contract changed. Review the current contract and try again.',
					{ status: 409, headers: noStore }
				);
			const template = await client.query(api.buyerLinks.templateContent, {
				token: params.token,
				templateVersionId: state.templateVersionId
			});
			snapshot = {
				kind: 'ready',
				title: state.title,
				blocks: template.blocks,
				concessions: state.concessions,
				appliedOverlays: state.appliedOverlays
			};
		}
		const items = toAppliedOverlayItems(snapshot.appliedOverlays);
		const blob = await generateWord(
			composeExport({
				blocks: snapshot.blocks,
				items,
				concessions: snapshot.concessions
			}),
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
