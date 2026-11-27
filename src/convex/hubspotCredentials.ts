import { v, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx } from './_generated/server';
import { hubspotConnection } from './hubspotValidators';

export const credentialFields = v.object({
	generation: v.number(),
	accessToken: v.string(),
	refreshToken: v.string(),
	expiresAt: v.number(),
	refreshClaim: v.optional(v.string()),
	refreshUntil: v.optional(v.number())
});
export const connectionWithCredentials = hubspotConnection.extend({
	_id: v.id('hubspotConnections'),
	_creationTime: v.number(),
	...credentialFields.fields
});
export type CredentialConnection = Infer<typeof connectionWithCredentials>;
export function credentialsFor(ctx: QueryCtx, connectionId: Id<'hubspotConnections'>) {
	return ctx.db
		.query('hubspotCredentials')
		.withIndex('by_connectionId', (q) => q.eq('connectionId', connectionId))
		.unique();
}
export async function attachCredentials(
	ctx: QueryCtx,
	connection: Doc<'hubspotConnections'> | null
): Promise<CredentialConnection | null> {
	if (!connection) return null;
	const credentials = await credentialsFor(ctx, connection._id);
	if (!credentials) return null;
	const { _id, _creationTime, companyId, connectionId, ...fields } = credentials;
	return { ...connection, ...fields };
}
export async function credentialConnection(ctx: QueryCtx, id: Id<'hubspotConnections'>) {
	return attachCredentials(ctx, await ctx.db.get('hubspotConnections', id));
}
export async function deleteCredentials(ctx: MutationCtx, connectionId: Id<'hubspotConnections'>) {
	const row = await credentialsFor(ctx, connectionId);
	if (row) await ctx.db.delete('hubspotCredentials', row._id);
}
