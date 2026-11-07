// @vitest-environment edge-runtime
import { describe, expect, it, vi } from 'vitest';
import {
	api,
	internal,
	fixture,
	application,
	events,
	integrationClock,
	markUnavailable,
	relink,
	readyExport,
	acknowledge,
	send,
	event,
	json
} from './fixtures';

integrationClock();

describe('HubSpot activity from contract operations', () => {
	it('creates one activity and receipt on linked creation replay, preserving the exact deal name', async () => {
		const f = await fixture();
		const replay = await f.t.mutation(internal.hubspotDeals.commit, {
			...f.creation,
			name: 'Renamed remotely'
		});
		expect(replay.status).toBe('created');
		expect(await events(f)).toMatchObject([{ kind: 'created', title: f.creation.name }]);
		expect(await f.t.run(({ db }) => db.query('savedContracts').collect())).toHaveLength(1);
		expect(await f.t.run(({ db }) => db.query('hubspotReceipts').collect())).toHaveLength(1);
		expect(await f.t.run(({ db }) => db.query('contractCreationReceipts').collect())).toHaveLength(
			0
		);
	});
	it('records applying once and records no separate approval event for admin auto-approval', async () => {
		const f = await fixture(),
			args = application(f);
		await f.t.mutation(api.contracts.saveChoices, args);
		await f.t.mutation(api.contracts.saveChoices, args);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'applied']);
		const state = await f.t.query(api.contracts.state, {
			membershipId: f.owner.membershipId,
			id: f.id
		});
		expect(state?.applications[f.itemId].approval).toMatchObject({
			status: 'approved',
			applicationId: 'application-1'
		});
		expect(await f.t.run(({ db }) => db.query('concessionDecisions').collect())).toHaveLength(1);
	});
	it('records an actual approval request and each explicit decision once despite replays', async () => {
		const f = await fixture();
		await f.repClient.mutation(api.contracts.saveChoices, {
			...application(f),
			membershipId: f.rep.membershipId
		});
		const request = {
			membershipId: f.rep.membershipId,
			id: f.id,
			expectedEditRevision: 1,
			operationId: 'request'
		};
		const first = await f.repClient.mutation(api.contractApprovals.request, request);
		expect(await f.repClient.mutation(api.contractApprovals.request, request)).toEqual(first);
		const decision = {
			membershipId: f.owner.membershipId,
			id: f.id,
			itemId: f.itemId,
			concessionId: 'preferred',
			applicationId: 'application-1',
			status: 'approved' as const,
			protocol: 1 as const,
			operationId: 'approve'
		};
		await f.t.mutation(api.contractApprovals.decide, decision);
		await f.t.mutation(api.contractApprovals.decide, decision);
		const decline = { ...decision, status: 'rejected' as const, operationId: 'decline' };
		await f.t.mutation(api.contractApprovals.decide, decline);
		await f.t.mutation(api.contractApprovals.decide, decline);
		expect((await events(f)).map((e) => e.kind)).toEqual([
			'created',
			'applied',
			'requested',
			'approved',
			'declined'
		]);
		expect(JSON.parse((await events(f))[2].detail)).toMatchObject({ count: 1 });
	});
	it('rolls back receipts, applications and activity when a later command fails', async () => {
		const f = await fixture(),
			args = application(f);
		const bad = {
			...args.commands[0],
			id: 'invalid-second',
			choice: { concessionId: 'absent', applicationId: 'bad' }
		};
		await expect(
			f.t.mutation(api.contracts.saveChoices, { ...args, commands: [...args.commands, bad] })
		).rejects.toThrow();
		expect((await events(f)).map((e) => e.kind)).toEqual(['created']);
		expect(await f.t.run(({ db }) => db.query('hubspotReceipts').collect())).toHaveLength(1);
		expect((await f.t.run(({ db }) => db.get('savedContracts', f.id)))?.applications).toEqual({});
		expect(await f.t.run(({ db }) => db.query('concessionDecisions').collect())).toHaveLength(0);
		await f.t.mutation(api.contracts.saveChoices, args);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'applied']);
	});
	it('records no activity on conflicting saves or failed approval requests', async () => {
		const f = await fixture();
		expect((await f.t.mutation(api.contracts.saveChoices, application(f, 'stale', 9))).status).toBe(
			'conflict'
		);
		await expect(
			f.t.mutation(api.contractApprovals.request, {
				membershipId: f.owner.membershipId,
				id: f.id,
				expectedEditRevision: 0,
				operationId: 'empty-request'
			})
		).rejects.toThrow('no concessions');
		expect((await events(f)).map((e) => e.kind)).toEqual(['created']);
	});
	it('records no extra activity for removal, rename, review reopening or deletion', async () => {
		const f = await fixture();
		await f.repClient.mutation(api.contracts.saveChoices, {
			...application(f),
			membershipId: f.rep.membershipId
		});
		await f.t.mutation(api.contractApprovals.decide, {
			membershipId: f.owner.membershipId,
			id: f.id,
			itemId: f.itemId,
			concessionId: 'preferred',
			applicationId: 'application-1',
			status: 'approved',
			protocol: 1,
			operationId: 'approve'
		});
		const current = (await f.t.run(({ db }) => db.get('savedContracts', f.id)))!;
		expect(
			await f.t.mutation(api.contractApprovals.resetCompletion, {
				membershipId: f.owner.membershipId,
				id: f.id,
				expectedGeneration: current.reviewGeneration
			})
		).toEqual({ outcome: 'reset' });
		const removed = await f.t.mutation(api.contracts.saveChoices, {
			membershipId: f.owner.membershipId,
			id: f.id,
			choices: {},
			operationId: 'remove',
			expectedEditRevision: 2,
			commands: [{ id: 'remove-command', itemId: f.itemId, choice: null, occurredAt: Date.now() }]
		});
		expect(removed.status).toBe('saved');
		expect((await f.t.run(({ db }) => db.get('savedContracts', f.id)))?.applications).toEqual({});
		await f.t.mutation(api.contracts.rename, {
			membershipId: f.owner.membershipId,
			id: f.id,
			buyerCompanyName: 'Renamed'
		});
		await f.t.mutation(api.contracts.remove, { membershipId: f.owner.membershipId, id: f.id });
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'applied', 'approved']);
	});
	it('queues review completion without adding another CRM activity', async () => {
		const f = await fixture();
		await f.repClient.mutation(api.contracts.saveChoices, {
			...application(f),
			membershipId: f.rep.membershipId
		});
		await f.t.mutation(api.contractApprovals.decide, {
			membershipId: f.owner.membershipId,
			id: f.id,
			itemId: f.itemId,
			concessionId: 'preferred',
			applicationId: 'application-1',
			status: 'approved',
			protocol: 1,
			operationId: 'approve'
		});
		const current = (await f.t.run(({ db }) => db.get('savedContracts', f.id)))!;
		expect(
			await f.t.mutation(api.contractApprovals.confirmCompletion, {
				membershipId: f.owner.membershipId,
				id: f.id,
				expectedGeneration: current.reviewGeneration
			})
		).toEqual({ outcome: 'queued' });
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'applied', 'approved']);
	});
});

describe('missing HubSpot deals and relinking', () => {
	it('blocks new work after a provider 404 while preserving the contract and accepted download acknowledgments', async () => {
		const f = await fixture();
		const attempt = await readyExport(f);
		const fetcher = vi.fn(async () => json({}, 404));
		vi.stubGlobal('fetch', fetcher);
		await send(f);
		expect(await event(f)).toMatchObject({ status: 'paused', destination: { dealId: '101' } });
		const contract = (await f.t.run(({ db }) => db.get('savedContracts', f.id)))!;
		expect(contract.buyerCompanyName).toBe(f.creation.name);
		expect(contract.hubspot?.availability).toBe('unavailable');
		await expect(f.t.mutation(api.contracts.saveChoices, application(f))).rejects.toThrow(
			'Link another deal'
		);
		await expect(readyExport(f, 'blocked-download')).rejects.toThrow('Link another deal');
		await acknowledge(f, attempt);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'downloaded']);
		expect((await events(f))[1].status).toBe('paused');
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('relinks and renames the contract; new activity uses the replacement and old events/exports keep their destination', async () => {
		const f = await fixture(),
			reserved = await readyExport(f);
		await markUnavailable(f);
		const repaired = await relink(f);
		expect(await relink(f)).toEqual(repaired);
		const contract = (await f.t.run(({ db }) => db.get('savedContracts', f.id)))!;
		expect(contract).toMatchObject({
			buyerCompanyName: 'Replacement deal',
			hubspot: { dealId: '202', generation: 2, availability: 'available' }
		});
		expect(await events(f)).toHaveLength(1);
		await f.t.mutation(api.contracts.saveChoices, application(f));
		const download = await acknowledge(f, reserved);
		expect((await events(f)).map((e) => [e.kind, e.destination.dealId])).toEqual([
			['created', '101'],
			['applied', '202'],
			['downloaded', '101']
		]);
		expect(download.destination.generation).toBe(1);
		await f.t.mutation(internal.hubspotDelivery.pump, {});
		expect((await events(f))[0].status).toBe('paused');
		expect((await events(f))[2].status).toBe('paused');
	});
});
