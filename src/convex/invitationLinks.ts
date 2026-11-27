import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { v } from 'convex/values';
import { query } from './_generated/server';
import { readInvitationPreview, readInvitationResolve } from './companyInvitations';
import { invitationPreview, invitationResolution } from './invitationValidators';
const tokenHash = (token: string) => bytesToHex(sha256(new TextEncoder().encode(token)));
export const preview = query({
	args: { token: v.string() },
	returns: invitationPreview,
	handler: (ctx, { token }) =>
		/^[A-Za-z0-9_-]{43}$/.test(token)
			? readInvitationPreview(ctx, tokenHash(token))
			: { status: 'unavailable' as const }
});
export const resolve = query({
	args: { token: v.string() },
	returns: invitationResolution,
	handler: (ctx, { token }) =>
		/^[A-Za-z0-9_-]{43}$/.test(token)
			? readInvitationResolve(ctx, tokenHash(token))
			: { status: 'unavailable' as const, companyName: null }
});
