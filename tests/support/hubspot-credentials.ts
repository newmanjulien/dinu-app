import type { Doc, Id } from '../../src/convex/_generated/dataModel';
import type { MutationCtx } from '../../src/convex/_generated/server';
type Connection = Omit<Doc<'hubspotConnections'>, '_id' | '_creationTime'>;
type Credentials = Pick<
	Doc<'hubspotCredentials'>,
	'generation' | 'accessToken' | 'refreshToken' | 'expiresAt' | 'refreshClaim' | 'refreshUntil'
>;
const credentialKeys = [
	'generation',
	'accessToken',
	'refreshToken',
	'expiresAt',
	'refreshClaim',
	'refreshUntil'
] as const;
export async function insertTestConnection(db: MutationCtx['db'], value: Connection & Credentials) {
	const {
		generation,
		accessToken,
		refreshToken,
		expiresAt,
		refreshClaim,
		refreshUntil,
		...connection
	} = value;
	const connectionId = await db.insert('hubspotConnections', connection);
	await db.insert('hubspotCredentials', {
		companyId: connection.companyId,
		connectionId,
		generation,
		accessToken,
		refreshToken,
		expiresAt,
		refreshClaim,
		refreshUntil
	});
	return connectionId;
}
export async function readTestConnection(db: MutationCtx['db'], id: Id<'hubspotConnections'>) {
	const connection = await db.get('hubspotConnections', id);
	if (!connection) return null;
	const credentials = await db
		.query('hubspotCredentials')
		.withIndex('by_connectionId', (q) => q.eq('connectionId', id))
		.unique();
	if (!credentials) throw new Error('Fixture credentials missing');
	const { _id, _creationTime, companyId, connectionId, ...tokens } = credentials;
	return { ...connection, ...tokens };
}
export async function patchTestConnection(
	db: MutationCtx['db'],
	id: Id<'hubspotConnections'>,
	patch: Partial<Connection & Credentials>
) {
	const tokens: Partial<Credentials> = {},
		stable: Partial<Connection> = {};
	for (const [key, value] of Object.entries(patch)) {
		Object.assign(
			credentialKeys.includes(key as (typeof credentialKeys)[number]) ? tokens : stable,
			{ [key]: value }
		);
	}
	if (Object.keys(stable).length) await db.patch('hubspotConnections', id, stable);
	if (Object.keys(tokens).length) {
		const credentials = await db
			.query('hubspotCredentials')
			.withIndex('by_connectionId', (q) => q.eq('connectionId', id))
			.unique();
		if (!credentials) throw new Error('Fixture credentials missing');
		await db.patch('hubspotCredentials', credentials._id, tokens);
	}
}
