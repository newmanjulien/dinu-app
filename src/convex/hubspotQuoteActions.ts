import { ConvexError, v, type Infer } from 'convex/values';
import { action, internalAction } from './_generated/server';
import { internal } from './_generated/api';
import { quoteRequest, quoteSummary } from './hubspotQuoteValidators';
import { composeExport } from '../lib/document/export/content';
import { equivalentTerms, exportHtml } from '../lib/document/export/html';
import { contractDocumentFromRenderTransport } from '../lib/document/contract-document';
import { connectionToken, hubspot, HubSpotError, readDeal } from './hubspotApi';
import { sha256 } from './operationReceipts';
import { quoteSemanticIdentity } from '../lib/document/export/quote-identity';
import { activeQuote, numericQuoteId, quotePath, quoteUrl } from './hubspotQuoteProvider';
import { contractName } from '../lib/contract/filename';
import { outputProgress, outputVerify } from './outputReferences';
const pending = (message: string) => new ConvexError({ code: 'OUTPUT_PENDING', message });

export const push = action({
	args: quoteRequest.extend({ operationId: v.string() }).fields,
	returns: quoteSummary,
	handler: async (ctx, args): Promise<Infer<typeof quoteSummary>> => {
		let admission = await ctx.runMutation(internal.hubspotQuotes.reserve, args);
		if (admission.kind === 'preparing') {
			for (let turn = 0; turn < 24; turn++)
				if (await ctx.runMutation(outputProgress, { receiptId: admission.receiptId })) break;
			admission = await ctx.runMutation(internal.hubspotQuotes.reserve, args);
		}
		if (admission.kind === 'preparing') throw pending('Preparing your HubSpot quote…');
		if (admission.kind === 'committed') return admission.summary;
		let verified = false;
		for (let turn = 0; turn < 64 && !verified; turn++)
			verified = await ctx.runMutation(outputVerify, {
				receiptId: admission.reservation.proof.receiptId
			});
		if (!verified) throw pending('Checking your HubSpot quote…');
		const { source, document } = await ctx.runQuery(internal.hubspotQuotes.content, args);
		const resolved = composeExport({
			document: contractDocumentFromRenderTransport(document)
		});
		const link = source.destination.hubspot;
		if (!link) throw new Error('Missing original Quote destination.');
		const identity = quoteSemanticIdentity(
			{
				companyId: source.companyId,
				contractId: source.contractId,
				accountId: link.accountId,
				dealId: link.dealId,
				title: source.title
			},
			resolved
		);

		const html = exportHtml(resolved);
		if (!html || html.length > 65_536)
			throw new ConvexError(
				'This contract exceeds HubSpot’s 65,536-character Terms limit after formatting. Nothing was sent. Contact Dinu support.'
			);
		if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(html))
			throw new ConvexError(
				'This contract contains characters HubSpot cannot render. Nothing was sent. Contact Dinu support.'
			);
		const payload = {
			...args,
			...identity,
			payloadHash: await sha256(html)
		};
		let release = await ctx.runMutation(internal.hubspotQuotes.prepareCommit, args);
		if (!release.complete) {
			for (let turn = 0; turn < 24; turn++)
				if (await ctx.runMutation(outputProgress, { receiptId: release.receiptId })) break;
			release = await ctx.runMutation(internal.hubspotQuotes.prepareCommit, args);
		}
		if (!release.complete) throw pending('Checking your HubSpot quote…');
		const commit = await ctx.runMutation(internal.hubspotQuotes.commit, payload);
		if (commit.kind === 'preparing') throw pending('Checking your HubSpot quote…');
		if (commit.kind === 'reused') return commit.summary;
		const fileId = await ctx.storage.store(new Blob([html], { type: 'text/html;charset=utf-8' }));
		try {
			const result = await ctx.runMutation(internal.hubspotQuotes.commit, {
				...payload,
				fileId
			});
			if (result.kind === 'preparing') throw pending('Checking your HubSpot quote…');
			if (result.kind !== 'reused') throw new Error('Payload reservation was not completed');
			return result.summary;
		} finally {
			// Also covers duplicate/reused handoffs and an ambiguous mutation response.
			await ctx.runMutation(internal.storageOwnership.discardFile, { fileId });
		}
	}
});

export const send = internalAction({
	args: { id: v.id('hubspotQuotePushes'), claim: v.string() },
	returns: v.null(),
	handler: async (ctx, args) => {
		const data = await ctx.runMutation(internal.hubspotQuotes.start, args);
		if (!data) return null;
		const { push } = data;
		let dispatched = false;
		let knownId = push.quoteId;
		let phase: 'credentials' | 'deal-read' | 'create' | 'verify' = 'credentials';
		try {
			if (!push.fileId) throw new Error('Missing immutable payload');
			const blob = await ctx.storage.get(push.fileId);
			if (!blob) throw new Error('Missing immutable payload');
			const html = await blob.text();
			if ((await sha256(html)) !== push.payloadHash) throw new Error('Immutable payload mismatch');
			const connection = await connectionToken(ctx, data.connection);
			if (push.state === 'queued') {
				phase = 'deal-read';
				if (!(await readDeal(ctx, connection, push.destination.dealId))) {
					await ctx.runMutation(internal.hubspotQuotes.settle, {
						...args,
						state: 'rejected',
						message: 'The linked HubSpot deal is unavailable. Link another deal, then push again.'
					});
					return null;
				}
				let preparation = await ctx.runMutation(internal.hubspotQuotes.prepareDispatch, {
					...args,
					generation: connection.generation
				});
				if (!preparation.complete) {
					for (let turn = 0; turn < 24; turn++)
						if (await ctx.runMutation(outputProgress, { receiptId: preparation.receiptId })) break;
					preparation = await ctx.runMutation(internal.hubspotQuotes.prepareDispatch, {
						...args,
						generation: connection.generation
					});
				}
				if (!preparation.complete) {
					await ctx.runMutation(internal.hubspotQuotes.deferPreparation, args);
					return null;
				}
				if (
					!(await ctx.runMutation(internal.hubspotQuotes.dispatch, {
						...args,
						generation: connection.generation
					}))
				) {
					await ctx.runMutation(internal.hubspotQuotes.settle, {
						...args,
						state: 'retired',
						message:
							'This contract or integration changed before sending. Push the saved version again.'
					});
					return null;
				}
				dispatched = true;
				phase = 'create';
				const result: unknown = await hubspot(
					ctx,
					connection,
					quotePath,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							properties: {
								hs_template_type: 'CPQ_QUOTE',
								hs_title: `${contractName(data.title).slice(0, 180)} — Dinu ${push.fingerprint.slice(0, 8)}`,
								hs_expiration_date: new Date(Date.now() + 30 * 24 * 60 * 60_000)
									.toISOString()
									.slice(0, 10),
								hs_terms: html,
								hs_payment_enabled: 'false',
								hs_billing_enabled: 'false'
							},
							associations: [
								{
									to: { id: push.destination.dealId },
									types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 64 }]
								}
							]
						})
					},
					false,
					'create'
				);
				if (
					!result ||
					typeof result !== 'object' ||
					!numericQuoteId((result as Record<string, unknown>).id)
				)
					throw new Error('Create returned no quote identity');
				knownId = (result as { id: string }).id;
				// Persist identity before any other reads; all continuations are GET only.
				await ctx.runMutation(internal.hubspotQuotes.settle, {
					...args,
					state: 'verifying',
					quoteId: knownId,
					url: quoteUrl(push.destination.accountId, knownId),
					delay: 3000
				});
				return null;
			}
			if (!knownId) throw new Error('Missing quote identity');
			phase = 'verify';
			const raw: unknown = await hubspot(
				ctx,
				connection,
				`${quotePath}/${knownId}?properties=hs_terms,hs_template_type&associations=deals`
			);
			const properties = activeQuote(raw, knownId, push.destination.dealId);
			if (!properties) {
				await ctx.runMutation(internal.hubspotQuotes.settle, {
					...args,
					state: 'attention',
					message:
						'The quote exists, but its type or linked deal could not be verified. Open it in HubSpot and contact Dinu support.'
				});
				return null;
			}
			const terms = properties.hs_terms;
			if (typeof terms !== 'string' || !terms) {
				await ctx.runMutation(internal.hubspotQuotes.settle, {
					...args,
					state: 'verifying',
					delay: 5000
				});
				return null;
			}
			const equivalent = equivalentTerms(html, terms);
			await ctx.runMutation(internal.hubspotQuotes.settle, {
				...args,
				state: equivalent ? 'verified' : 'attention',
				...(!equivalent
					? {
							message:
								'The quote exists, but its Terms differ from the contract sent. Review the quote in HubSpot and contact Dinu support.'
						}
					: {})
			});
		} catch (error) {
			const provider = error instanceof HubSpotError ? error : null;
			const definite =
				!dispatched ||
				provider?.stage === 'not-attempted' ||
				(provider && [400, 401, 403, 404, 413, 422, 429].includes(provider.status));
			const message =
				provider?.status === 401
					? 'Ask an admin to reconnect HubSpot, then push again.'
					: provider?.status === 403
						? 'HubSpot denied Quotes access. Ask an admin to check Revenue Hub, permissions and the Quotes connection.'
						: provider?.status === 429
							? 'HubSpot is limiting requests. Wait a moment, then try again.'
							: definite
								? 'HubSpot did not accept this push. Check the integration and account requirements, then try again.'
								: 'HubSpot may have created this quote. Contact Dinu support before pushing this version again.';
			await ctx.runMutation(internal.hubspotQuotes.settle, {
				...args,
				state: knownId ? 'verifying' : definite ? 'rejected' : 'unknown',
				...(knownId
					? {
							quoteId: knownId,
							url: quoteUrl(push.destination.accountId, knownId),
							delay: provider?.retryAfter ?? 10_000
						}
					: { message }),
				...(provider
					? {
							providerFailure: {
								capturedAt: Date.now(),
								expiresAt: Date.now() + 30 * 24 * 60 * 60_000,
								phase,
								purpose: provider.purpose,
								stage: provider.stage,
								status: provider.status,
								retryAfter: provider.retryAfter,
								...(provider.detail?.category ? { category: provider.detail.category } : {}),
								...(provider.detail?.code ? { code: provider.detail.code } : {}),
								...(provider.detail?.correlationId
									? { correlationId: provider.detail.correlationId }
									: {})
							}
						}
					: {})
			});
		}
		return null;
	}
});
