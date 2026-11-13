import { vi } from 'vitest';
import {
	api,
	internal,
	currentContract,
	expectedSource,
	NOW,
	type Fixture
} from '../../support/linked-contract';

export async function installQuotes(f: Fixture) {
	vi.stubEnv('HUBSPOT_QUOTES_ENABLED', 'true');
	vi.stubEnv('HUBSPOT_QUOTES_PUSH_ENABLED', 'true');
	await f.t.run(async ({ db }) => {
		await db.patch('hubspotConnections', f.connectionId, {
			scopes: ['oauth', 'crm.objects.quotes.read', 'crm.objects.quotes.write']
		});
		await db.insert('hubspotQuoteInstallations', {
			companyId: f.owner.companyId,
			connectionId: f.connectionId,
			accountId: '12345',
			enabled: true,
			epoch: 1,
			installedAt: NOW,
			installerId: f.owner.profileId
		});
	});
}
export async function quoteArgs(f: Fixture, operationId = 'quote') {
	const { availability, ...destination } = (await currentContract(f)).hubspot!;
	return {
		membershipId: f.owner.membershipId,
		id: f.id,
		operationId,
		expectedSource: await expectedSource(f),
		destination
	};
}
export async function pushQuote(f: Fixture, operationId = 'quote') {
	return f.t.action(api.hubspotQuoteActions.push, await quoteArgs(f, operationId));
}
export async function sendQuote(
	f: Fixture,
	id: import('../../../src/convex/_generated/dataModel').Id<'hubspotQuotePushes'>
) {
	await f.t.mutation(internal.hubspotQuotes.pump, {});
	const row = await f.t.run(({ db }) => db.get('hubspotQuotePushes', id));
	if (!row?.claim) throw new Error('Quote was not queued');
	await f.t.action(internal.hubspotQuoteActions.send, { id, claim: row.claim });
	return f.t.run(({ db }) => db.get('hubspotQuotePushes', id));
}
