import { httpRouter } from 'convex/server';
import { ConvexError } from 'convex/values';
import { Webhook } from 'svix';
import { internal } from './_generated/api';
import { env, httpAction } from './_generated/server';
import { preflight, upload } from './templateUploads';
import { webhook as calWebhook } from './csmBookings';
import { readUploadBody } from './uploadHttp';
import { readTextBody } from '../lib/http-body';
import { validate } from 'convex-helpers/validators';
import { discussionRequest } from '../lib/discussions/transport';
import { v } from 'convex/values';
import { readActivity } from '../lib/buyer/activity-transport';
const http = httpRouter();
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const CLERK_WEBHOOK_MAX_BYTES = 256 * 1024;
http.route({ path: '/templates/upload', method: 'POST', handler: upload });
http.route({ path: '/templates/upload', method: 'OPTIONS', handler: preflight });
http.route({ path: '/cal/webhook', method: 'POST', handler: calWebhook });
http.route({
	path: '/clerk/webhook',
	method: 'POST',
	handler: httpAction(async (ctx, request) => {
		const secret = env.CLERK_WEBHOOK_SIGNING_SECRET;
		const issuer = env.CLERK_JWT_ISSUER_DOMAIN;
		if (!secret || !issuer) return new Response('Webhook is not configured', { status: 503 });
		if (Number(request.headers.get('content-length')) > CLERK_WEBHOOK_MAX_BYTES)
			return new Response('Webhook payload too large', { status: 413 });
		const reader = request.body?.getReader();
		if (!reader) return new Response('Invalid event', { status: 400 });
		const body = await readTextBody(reader, CLERK_WEBHOOK_MAX_BYTES);
		if (body === null) return new Response('Webhook payload too large', { status: 413 });
		try {
			new Webhook(secret).verify(body, {
				'svix-id': request.headers.get('svix-id') ?? '',
				'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
				'svix-signature': request.headers.get('svix-signature') ?? ''
			});
		} catch {
			return new Response('Invalid signature', { status: 400 });
		}
		let event: unknown;
		try {
			event = JSON.parse(body);
		} catch {
			return new Response('Invalid event', { status: 400 });
		}
		if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string')
			return new Response('Invalid event', { status: 400 });
		if (event.type === 'user.deleted') {
			if (
				!('data' in event) ||
				!event.data ||
				typeof event.data !== 'object' ||
				!('id' in event.data) ||
				typeof event.data.id !== 'string' ||
				!event.data.id
			)
				return new Response('Missing user ID', { status: 400 });
			await ctx.runMutation(internal.accountDeletion.mark, { issuer, clerkId: event.data.id });
		}
		return new Response(null, { status: 204 });
	})
});
http.route({
	path: '/avatar',
	method: 'POST',
	handler: httpAction(async (ctx, request) => {
		try {
			if (!(await ctx.auth.getUserIdentity()))
				return new Response('Sign in required.', { status: 401 });
			const params = new URL(request.url).searchParams;
			const company = params.get('company') === 'true';
			const membershipId = params.get('membershipId') as
				import('./_generated/dataModel').Id<'memberships'> | null;
			if (company && !membershipId)
				return new Response('Company access is required.', { status: 403 });
			try {
				await ctx.runQuery(internal.avatars.authorizeAvatarUpload, {
					company,
					membershipId: membershipId ?? undefined
				});
			} catch (error) {
				if (error instanceof ConvexError && typeof error.data === 'string')
					return new Response(error.data, { status: 403 });
				throw error;
			}
			const contentType = request.headers.get('content-type') ?? '';
			if (
				!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(contentType)
			)
				return new Response('Choose a JPEG, PNG, WebP, GIF or AVIF image.', { status: 400 });
			if (Number(request.headers.get('content-length')) > AVATAR_MAX_BYTES)
				return new Response('Avatar image must be 2 MB or smaller.', { status: 413 });
			const reader = request.body?.getReader();
			if (!reader) return new Response('Avatar image is required.', { status: 400 });
			const body = await readUploadBody(reader, AVATAR_MAX_BYTES);
			if (!body) return new Response('Avatar image must be 2 MB or smaller.', { status: 413 });
			const blob = new Blob(body.chunks, { type: contentType });
			const avatarId = await ctx.storage.store(blob);
			try {
				await ctx.runMutation(internal.avatars.setAvatar, {
					avatarId,
					membershipId: membershipId ?? undefined,
					company
				});
			} catch (error) {
				try {
					await ctx.runMutation(internal.storageOwnership.discardFile, { fileId: avatarId });
				} catch (cleanupError) {
					console.error('Unable to clean up avatar after failed save.', { error, cleanupError });
				}
				if (error instanceof ConvexError && typeof error.data === 'string')
					return new Response(error.data, { status: 409 });
				throw error;
			}
			return new Response(null, { status: 204 });
		} catch (error) {
			console.error('Unable to save avatar.', error);
			return new Response('Unable to save your avatar. Try again.', { status: 500 });
		}
	})
});
const recordBuyerActivity = httpAction(async (ctx, request) => {
	if (
		!env.BUYER_LINK_INGEST_SECRET ||
		request.headers.get('X-Buyer-Ingest-Secret') !== env.BUYER_LINK_INGEST_SECRET
	)
		return new Response(null, { status: 403 });
	const body = await readActivity(request);
	if (!body) return new Response(null, { status: 400 });
	const device = request.headers.get('X-Buyer-Device');
	try {
		const result = await ctx.runMutation(internal.buyerActivity.record, {
			request: body,
			city: body.kind === 'open' ? (request.headers.get('X-Buyer-City') ?? undefined) : undefined,
			device:
				device === 'computer' || device === 'phone' || device === 'tablet' ? device : undefined
		});
		const headers = { 'Cache-Control': 'private, no-store' };
		if (result.kind === 'recorded' && body.kind === 'open')
			return new Response(JSON.stringify({ expiresAt: result.expiresAt }), {
				status: 200,
				headers: { ...headers, 'Content-Type': 'application/json' }
			});
		return new Response(null, {
			status: result.kind === 'limited' ? 429 : result.kind === 'unavailable' ? 404 : 204,
			headers:
				result.kind === 'limited'
					? { ...headers, 'Retry-After': String(result.retryAfter) }
					: headers
		});
	} catch (error) {
		if (error instanceof ConvexError) return new Response(null, { status: 400 });
		throw error;
	}
});
http.route({ path: '/buyer/activity', method: 'POST', handler: recordBuyerActivity });
http.route({
	path: '/buyer/discussions',
	method: 'POST',
	handler: httpAction(async (ctx, request) => {
		const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' };
		const failure = (message: string, status: number) =>
			new Response(JSON.stringify({ message }), { status, headers });
		if (
			!env.BUYER_LINK_INGEST_SECRET ||
			request.headers.get('X-Buyer-Ingest-Secret') !== env.BUYER_LINK_INGEST_SECRET
		)
			return failure('Unavailable.', 403);
		const reader = request.body?.getReader();
		if (!reader) return failure('Invalid request.', 400);
		try {
			const text = await readTextBody(reader, 151_000);
			if (text === null) return failure('Message too large.', 400);
			const body: unknown = JSON.parse(text);
			const validator = v.union(
				...discussionRequest.members.map((member) => member.extend({ browserId: v.string() }))
			);
			if (!validate(validator, body)) return failure('Invalid request.', 400);
			const result =
				body.kind === 'viewer'
					? await ctx.runQuery(internal.discussions.buyerViewer, {
							token: body.token,
							browserId: body.browserId
						})
					: body.kind === 'result'
						? await ctx.runQuery(internal.discussions.buyerResult, {
								token: body.token,
								browserId: body.browserId,
								operationId: body.operationId,
								expectedAuthorKey: body.expectedAuthorKey,
								command: body.command
							})
						: await ctx.runMutation(internal.discussions.buyerWrite, {
								token: body.token,
								browserId: body.browserId,
								operationId: body.operationId,
								expectedAuthorKey: body.expectedAuthorKey,
								command: body.command
							});
			return new Response(JSON.stringify(result), { headers });
		} catch (error) {
			if (
				error instanceof ConvexError &&
				error.data &&
				typeof error.data === 'object' &&
				'code' in error.data &&
				error.data.code === 'DISCUSSION_IDENTITY_CHANGED'
			)
				return failure(
					'Reconnect as the original author before retrying. Your draft is still here.',
					401
				);
			if (
				error instanceof ConvexError &&
				error.data &&
				typeof error.data === 'object' &&
				'code' in error.data &&
				typeof error.data.code === 'string' &&
				['OPERATION_EXPIRED', 'OPERATION_INVALID', 'OPERATION_FUTURE'].includes(error.data.code)
			)
				return new Response(JSON.stringify(error.data), { status: 409, headers });
			if (error instanceof ConvexError)
				return failure(
					typeof error.data === 'string' ? error.data : 'This message could not be saved.',
					409
				);
			console.error('Discussion request failed');
			return failure('Comments are temporarily unavailable. Try again.', 503);
		}
	})
});
http.route({
	path: '/buyer/name',
	method: 'POST',
	handler: httpAction(async (ctx, request) => {
		const headers = { 'Cache-Control': 'private, no-store' };
		if (
			!env.BUYER_LINK_INGEST_SECRET ||
			request.headers.get('X-Buyer-Ingest-Secret') !== env.BUYER_LINK_INGEST_SECRET
		)
			return new Response(null, { status: 403, headers });
		const reader = request.body?.getReader();
		if (!reader) return new Response(null, { status: 400, headers });
		try {
			const text = await readTextBody(reader, 512);
			const body: unknown = text === null ? null : JSON.parse(text);
			if (!validate(v.object({ token: v.string() }), body))
				return new Response(null, { status: 400, headers });
			await ctx.runMutation(internal.hubspotRecipients.buyerRequest, body);
			return new Response(null, { status: 204, headers });
		} catch {
			return new Response(null, { status: 503, headers });
		}
	})
});
export default http;
