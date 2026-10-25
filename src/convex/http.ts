import { httpRouter } from 'convex/server';
import { ConvexError } from 'convex/values';
import { env, httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { Webhook } from 'svix';
import { upload, preflight } from './baselineUploads';
import { upload as delegationUpload, preflight as delegationPreflight } from './delegationUploads';
const http = httpRouter();
http.route({ path: '/delegation-attachment', method: 'POST', handler: delegationUpload });
http.route({ path: '/delegation-attachment', method: 'OPTIONS', handler: delegationPreflight });
http.route({ path: '/baseline', method: 'POST', handler: upload });
http.route({ path: '/baseline', method: 'OPTIONS', handler: preflight });
http.route({
	path: '/clerk/webhook',
	method: 'POST',
	handler: httpAction(async (ctx, request) => {
		const secret = env.CLERK_WEBHOOK_SIGNING_SECRET;
		const issuer = env.CLERK_JWT_ISSUER_DOMAIN;
		if (!secret || !issuer) return new Response('Webhook is not configured', { status: 503 });
		const body = await request.text();
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
				await ctx.runQuery(internal.settings.authorizeAvatarUpload, {
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
			const blob = await request.blob();
			if (blob.size > 2 * 1024 * 1024)
				return new Response('Avatar image must be 2 MB or smaller.', { status: 400 });
			const avatarId = await ctx.storage.store(blob);
			try {
				await ctx.runMutation(internal.settings.setAvatar, {
					avatarId,
					membershipId: membershipId ?? undefined,
					company
				});
			} catch (error) {
				try {
					await ctx.storage.delete(avatarId);
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
export default http;
