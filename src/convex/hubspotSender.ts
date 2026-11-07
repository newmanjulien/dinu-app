import { v } from 'convex/values';
import { internalAction } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { env } from './_generated/server';
import { internal } from './_generated/api';
import { retainedUntil } from './hubspotExports';
import { connectionToken, hubspot, readDeal, HubSpotError } from './hubspotApi';

function html(s: string) {
	return s
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}
function detailText(event: Doc<'hubspotEvents'>): string {
	try {
		const detail = JSON.parse(event.detail);
		if (typeof detail.description === 'string') return `Concession: ${detail.description}`;
		if (event.kind === 'requested')
			return `Approval requested for ${detail.count} concession${detail.count === 1 ? '' : 's'}.`;
		if (event.kind === 'downloaded') return `Document: ${detail.filename}`;
		return '';
	} catch {
		return event.detail;
	}
}
function marker(event: Doc<'hubspotEvents'>) {
	return `Dinu activity ${event._id}`;
}
function filename(event: Doc<'hubspotEvents'>) {
	return `dinu-${event._id}.docx`;
}
// Serial reconciliation deliberately avoids an unverified provider batch contract.
// Each segment: <=12 HTTP requests, <=150s elapsed, <=64MiB verified body bytes.
// A request starts only with 30s reserve; a File unit reserves 3 requests and 80s.
const REQUESTS = 12,
	SEGMENT_MS = 150_000,
	BODY_BYTES = 64 * 1024 * 1024;
class YieldObservation extends Error {}
async function boundedBytes(response: Response, expected: number) {
	if (!Number.isSafeInteger(expected) || expected < 0 || expected > BODY_BYTES || !response.body)
		return null;
	const reader = response.body.getReader(),
		chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > expected || size > BODY_BYTES) return null;
			chunks.push(part.value);
		}
		if (size !== expected) return null;
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} finally {
		await reader.cancel().catch(() => {});
	}
}
export const send = internalAction({
	args: { id: v.id('hubspotEvents'), execution: v.string() },
	returns: v.null(),
	handler: async (ctx, { id, execution }): Promise<null> => {
		if (!env.APP_URL) return null;
		const started = Date.now(),
			claim = crypto.randomUUID();
		let event = await ctx.runMutation(internal.hubspotDelivery.claim, { id, claim, execution });
		if (!event) return null;
		let connection: Doc<'hubspotConnections'> | null = null;
		let freshDispatch: string | undefined;
		let requests = 0,
			bodyBytes = 0;
		const horizon = event.dispatch
			? (event.dispatchedAt ?? event._creationTime) + 24 * 60 * 60_000
			: Infinity;
		const allowance = event.operatorObservation ? Infinity : horizon;
		const reserve = (count = 1, ms = 30_000) => {
			if (
				requests + count > REQUESTS ||
				Date.now() + ms > started + SEGMENT_MS ||
				Date.now() >= allowance
			)
				throw new YieldObservation();
		};
		const authority = async () => {
			if (
				!connection ||
				!(await ctx.runQuery(internal.hubspotDelivery.authorizeRead, {
					id,
					claim,
					generation: connection.generation
				}))
			)
				throw new YieldObservation();
		};
		const read = async (path: string) => {
			reserve();
			await authority();
			requests++;
			return hubspot(ctx, connection!, path);
		};
		const settle = async (
			outcome:
				| 'file'
				| 'sent'
				| 'retry'
				| 'unavailable'
				| 'uncertain'
				| 'attention'
				| 'reconnect'
				| 'blocked',
			remoteId?: string,
			delay?: number,
			diagnostic?: string,
			definitelyUnsent = false
		) =>
			ctx.runMutation(internal.hubspotDelivery.settle, {
				id,
				claim,
				generation: connection?.generation ?? -1,
				outcome,
				remoteId,
				delay,
				diagnostic,
				dispatchId: freshDispatch ?? event!.dispatchId,
				definitelyUnsent
			});
		try {
			const raw = await ctx.runQuery(internal.hubspotConnections.read, {
				id: event.destination.connectionId
			});
			if (!raw) {
				await settle('blocked');
				return null;
			}
			connection = raw;
			if (raw.expiresAt <= Date.now() + 60_000) {
				reserve();
				requests++;
			}
			connection = await connectionToken(ctx, connection);
			if (event.dispatch) {
				if (!event.dispatchId) {
					await settle('attention', undefined, undefined, 'Missing dispatch identity');
					return null;
				}
				reserve();
				let progress: NonNullable<Doc<'hubspotEvents'>['observation']> =
					event.observation &&
					event.observation.dispatchId === event.dispatchId &&
					event.observation.kind === event.dispatch
						? event.observation
						: {
								dispatchId: event.dispatchId!,
								kind: event.dispatch,
								pass: crypto.randomUUID(),
								page: 0,
								ids: [],
								position: 0,
								unresolved: 0
							};
				const checkpoint = async () => {
					if (
						!(await ctx.runMutation(internal.hubspotDelivery.checkpoint, {
							id,
							claim,
							observation: progress
						}))
					)
						throw new YieldObservation();
				};
				const memberFailure = (error: unknown) => {
					if (error instanceof YieldObservation) throw error;
					if (error instanceof HubSpotError && [401, 409, 429].includes(error.status)) throw error;
					// A member-local failure leaves an unresolved hole, not a negative write result.
					progress.unresolved = Math.min(500, progress.unresolved + 1);
				};
				if (event.dispatch === 'note') {
					while (progress.page < 5) {
						if (!progress.ids.length) {
							const associations = await read(
								`/crm/v4/objects/deals/${event.destination.dealId}/associations/notes?limit=100${progress.after ? `&after=${encodeURIComponent(progress.after)}` : ''}`
							);
							if (!Array.isArray(associations.results)) throw new HubSpotError(502);
							progress = {
								...progress,
								ids: associations.results
									.slice(0, 100)
									.map((a: { toObjectId: string | number }) => String(a.toObjectId)),
								position: 0,
								next:
									associations.paging?.next?.after === undefined
										? undefined
										: String(associations.paging.next.after)
							};
							await checkpoint();
						}
						for (; progress.position < progress.ids.length;) {
							try {
								const note = await read(
									`/crm/v3/objects/notes/${encodeURIComponent(progress.ids[progress.position])}?properties=hs_note_body`
								);
								if (
									note.id &&
									String(note.properties?.hs_note_body ?? '').includes(marker(event))
								) {
									await settle('sent', String(note.id));
									return null;
								}
							} catch (error) {
								memberFailure(error);
							}
							progress.position++;
							await checkpoint();
						}
						if (!progress.next || progress.page === 4) break;
						progress = {
							...progress,
							after: progress.next,
							next: undefined,
							page: progress.page + 1,
							ids: [],
							position: 0
						};
						await checkpoint();
					}
				} else {
					const data = await ctx.runQuery(internal.hubspotDelivery.data, { id });
					if (!progress.ids.length) {
						const candidates = await read(
							`/files/v3/files/search?name=${encodeURIComponent(filename(event).slice(0, 18))}&limit=100`
						);
						if (!Array.isArray(candidates.results)) throw new HubSpotError(502);
						progress = {
							...progress,
							ids: candidates.results.slice(0, 100).map((f: { id: string }) => String(f.id)),
							position: 0
						};
						await checkpoint();
					}
					for (; progress.position < progress.ids.length;) {
						reserve(3, 80_000);
						try {
							const file = await read(
								`/files/v3/files/${encodeURIComponent(progress.ids[progress.position])}`
							);
							if (
								(file.name === filename(event) ||
									`${file.name}.${file.extension}` === filename(event)) &&
								file.access === 'PRIVATE' &&
								data?.attempt?.sha256 &&
								data.attempt.size !== undefined
							) {
								const expected = data.attempt.size;
								if (expected > BODY_BYTES)
									throw new Error('File exceeds bounded verification allowance');
								if (bodyBytes + expected > BODY_BYTES) throw new YieldObservation();
								const signed = await read(
									`/files/v3/files/${encodeURIComponent(file.id)}/signed-url`
								);
								if (typeof signed.url === 'string') {
									reserve();
									await authority();
									requests++;
									const response = await fetch(signed.url, { signal: AbortSignal.timeout(25_000) });
									const bytes = response.ok ? await boundedBytes(response, expected) : null;
									bodyBytes += expected;
									if (bytes) {
										const digest = Array.from(
											new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
											(b) => b.toString(16).padStart(2, '0')
										).join('');
										if (digest === data.attempt.sha256) {
											await settle('file', String(file.id));
											event = {
												...event,
												fileId: String(file.id),
												dispatch: undefined,
												dispatchId: undefined
											};
											break;
										}
									}
								}
							}
						} catch (error) {
							memberFailure(error);
						}
						progress.position++;
						await checkpoint();
					}
				}
				if (event.dispatch) {
					// A finished attempted frontier can still contain unresolved holes. Start a new pass later.
					progress = {
						dispatchId: event.dispatchId!,
						kind: event.dispatch,
						pass: crypto.randomUUID(),
						page: 0,
						ids: [],
						position: 0,
						unresolved: progress.unresolved
					};
					await checkpoint();
					await settle(
						'uncertain',
						undefined,
						Math.min(60 * 60_000, 60_000 * event.tries),
						'Unconfirmed remote write; positive evidence required.'
					);
					return null;
				}
			}
			reserve();
			await authority();
			requests++;
			if (!(await readDeal(ctx, connection, event.destination.dealId))) {
				await settle('unavailable', undefined, undefined, 'Linked HubSpot deal unavailable');
				return null;
			}
			const data = await ctx.runQuery(internal.hubspotDelivery.data, { id });
			if (!data) {
				await settle('blocked');
				return null;
			}
			const attempt = data.attempt;
			if (event.kind === 'downloaded' && !event.fileId && attempt?.remoteFileId)
				event = { ...event, fileId: attempt.remoteFileId };
			if (
				event.kind === 'downloaded' &&
				!event.fileId &&
				attempt?.fileId &&
				retainedUntil(attempt) > Date.now()
			) {
				const blob = await ctx.storage.get(attempt.fileId);
				if (blob) {
					const form = new FormData();
					form.set('file', blob, filename(event));
					form.set('folderPath', `/Dinu/${event.companyId}`);
					form.set('options', JSON.stringify({ access: 'PRIVATE', overwrite: false }));
					reserve();
					await authority();
					freshDispatch =
						(await ctx.runMutation(internal.hubspotDelivery.dispatch, {
							id,
							claim,
							generation: connection.generation,
							kind: 'file'
						})) ?? undefined;
					if (!freshDispatch) {
						await settle('blocked');
						return null;
					}
					requests++;
					const file = await hubspot(
						ctx,
						connection,
						'/files/v3/files',
						{ method: 'POST', body: form },
						false,
						'create'
					);
					if (!file.id || (file.access && file.access !== 'PRIVATE'))
						throw new HubSpotError(502, 60_000, 'attempted', 'create');
					await settle('file', String(file.id));
					freshDispatch = undefined;
					event = { ...event, fileId: String(file.id) };
				}
			}
			const verbs = {
				created: 'created the contract',
				applied: 'applied a concession',
				requested: 'requested approval',
				approved: 'approved a concession',
				declined: 'declined a concession',
				downloaded: 'downloaded the contract'
			};
			const url = new URL(`/contracts/${event.contractId}`, env.APP_URL!);
			let body = `<p>${html(event.actor.name || event.actor.email)} ${verbs[event.kind]}: <strong>${html(event.title.slice(0, 2000))}</strong>.</p><p>${html(detailText(event).slice(0, 6000))}</p><p><a href="${html(url.toString())}">Open contract</a></p>`;
			if (event.kind === 'downloaded' && !event.fileId)
				body += '<p>The DOCX attachment is unavailable.</p>';
			body += `<p>${marker(event)}</p>`;
			const noteBody = JSON.stringify({
				properties: {
					hs_timestamp: new Date(event.occurredAt).toISOString(),
					hs_note_body: body,
					...(event.fileId ? { hs_attachment_ids: event.fileId } : {})
				},
				associations: [
					{
						to: { id: event.destination.dealId },
						types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }]
					}
				]
			});
			reserve();
			await authority();
			freshDispatch =
				(await ctx.runMutation(internal.hubspotDelivery.dispatch, {
					id,
					claim,
					generation: connection.generation,
					kind: 'note'
				})) ?? undefined;
			if (!freshDispatch) {
				await settle('blocked');
				return null;
			}
			requests++;
			const note = await hubspot(
				ctx,
				connection,
				'/crm/v3/objects/notes',
				{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: noteBody },
				false,
				'create'
			);
			if (!note.id) throw new HubSpotError(502, 60_000, 'attempted', 'create');
			await settle('sent', String(note.id));
		} catch (error) {
			const e = error instanceof HubSpotError ? error : null;
			const safeLocalDenial = Boolean(
				freshDispatch && e?.purpose === 'create' && e.stage === 'not-attempted'
			);
			if (e?.status === 401) await settle('reconnect', undefined, 5 * 60_000, 'Reconnect HubSpot');
			else if (error instanceof YieldObservation)
				await settle('retry', undefined, 60_000, 'Bounded delivery segment yielded');
			else if (e?.status === 429 || safeLocalDenial)
				await settle(
					'retry',
					undefined,
					e?.retryAfter,
					'HubSpot request deferred',
					safeLocalDenial
				);
			else if (event.dispatch || freshDispatch)
				await settle('uncertain', undefined, 60_000, 'Remote write outcome unknown');
			else if (e && [400, 403, 404].includes(e.status))
				await settle('attention', undefined, 60_000, `HubSpot rejected the request (${e.status})`);
			else
				await settle(
					event.tries < 10 ? 'retry' : 'attention',
					undefined,
					Math.min(60 * 60_000, 1000 * 2 ** Math.min(event.tries, 12)),
					'HubSpot temporarily unavailable'
				);
		}
		return null;
	}
});
