// @vitest-environment edge-runtime
import { describe, expect, it, vi } from 'vitest';
import {
	api,
	internal,
	fixture,
	currentContract,
	reviewExpectation,
	playbookState,
	decision,
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
} from '../../support/linked-contract';

integrationClock();

describe('HubSpot activity from contract operations', () => {
	it('records linked creation and admin application once on replay without a separate approval event', async () => {
		const f = await fixture();
		const replay = await f.t.mutation(internal.hubspotDeals.commit, {
			...f.creation,
			name: 'Renamed remotely'
		});
		expect(replay.status).toBe('created');
		expect(await events(f)).toMatchObject([{ kind: 'created', title: f.creation.name }]);
		expect(await f.t.run(({ db }) => db.query('savedContracts').collect())).toHaveLength(1);
		expect(await f.t.run(({ db }) => db.query('operationReceipts').collect())).toHaveLength(1);
		expect(await f.t.run(({ db }) => db.query('contractCreationReceipts').collect())).toHaveLength(
			0
		);
		const args = application(f);
		await f.t.mutation(api.contracts.saveChanges, args);
		await f.t.mutation(api.contracts.saveChanges, args);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'applied']);
		const state = await f.t.query(api.contracts.state, {
			membershipId: f.owner.membershipId,
			id: f.id
		});
		expect(state?.playbook).toMatchObject([
			{
				itemId: f.itemId,
				currentOptionId: 'preferred',
				appliedOptionId: 'preferred',
				status: 'approved',
				decisionId: expect.any(String)
			}
		]);
		expect(await f.t.run(({ db }) => db.query('contractChangeDecisions').collect())).toHaveLength(
			1
		);
	});
	it('records an actual approval request and each explicit decision once despite replays', async () => {
		const f = await fixture();
		await f.repClient.mutation(api.contracts.saveChanges, {
			...application(f),
			membershipId: f.rep.membershipId
		});
		const request = {
			membershipId: f.rep.membershipId,
			id: f.id,
			...(await reviewExpectation(f)),
			operationId: 'request'
		};
		const first = await f.repClient.mutation(api.contractApprovals.request, request);
		expect(await f.repClient.mutation(api.contractApprovals.request, request)).toEqual(first);
		const decline = await decision(f, 'decline', 'decline');
		await f.t.mutation(api.contractApprovals.decideChange, decline);
		await f.t.mutation(api.contractApprovals.decideChange, decline);
		const approval = await decision(f, 'approve', 'approve');
		await f.t.mutation(api.contractApprovals.decideChange, approval);
		await f.t.mutation(api.contractApprovals.decideChange, approval);
		expect((await events(f)).map((e) => e.kind)).toEqual([
			'created',
			'applied',
			'requested',
			'declined',
			'approved'
		]);
		expect(JSON.parse((await events(f))[2].detail)).toMatchObject({ count: 1 });
	});
	it('rolls back receipts, applications and activity when a later command fails', async () => {
		const f = await fixture(),
			args = application(f);
		const bad = {
			...args.commands[0],
			id: 'invalid-second',
			action: { kind: 'set' as const, optionId: 'absent' }
		};
		await expect(
			f.t.mutation(api.contracts.saveChanges, { ...args, commands: [...args.commands, bad] })
		).rejects.toThrow();
		expect((await events(f)).map((e) => e.kind)).toEqual(['created']);
		expect(await f.t.run(({ db }) => db.query('operationReceipts').collect())).toHaveLength(1);
		expect((await playbookState(f)).playbook).toEqual([]);
		expect(await f.t.run(({ db }) => db.query('contractChangeDecisions').collect())).toHaveLength(
			0
		);
		await f.t.mutation(api.contracts.saveChanges, args);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'applied']);
	});
	it('records no activity on conflicting saves or failed approval requests', async () => {
		const f = await fixture();
		const competitor = await fixture();
		await competitor.t.mutation(api.contracts.saveChanges, application(competitor));
		const competingHead = (await playbookState(competitor)).playbook[0].currentChangeId;
		const stale = application(f, 'stale');
		expect(
			(
				await f.t.mutation(api.contracts.saveChanges, {
					...stale,
					commands: stale.commands.map((command) => ({
						...command,
						expectedCurrentChangeId: competingHead
					}))
				})
			).status
		).toBe('conflict');
		await expect(
			f.t.mutation(api.contractApprovals.request, {
				membershipId: f.owner.membershipId,
				id: f.id,
				...(await reviewExpectation(f)),
				operationId: 'empty-request'
			})
		).rejects.toThrow('no changes waiting for approval');
		expect((await events(f)).map((e) => e.kind)).toEqual(['created']);
	});
	it('queues review completion and records no extra activity for completion, removal, rename or deletion', async () => {
		const f = await fixture();
		await f.repClient.mutation(api.contracts.saveChanges, {
			...application(f),
			membershipId: f.rep.membershipId
		});
		await f.t.mutation(api.contractApprovals.decideChange, await decision(f, 'approve', 'approve'));
		const current = await playbookState(f);
		expect(
			await f.t.mutation(api.contractApprovals.confirmCompletion, {
				membershipId: f.owner.membershipId,
				id: f.id,
				context: 'playbook',
				expectedIdentity: current.playbookReviewIdentity,
				operationId: 'complete-review',
				notify: true
			})
		).toMatchObject({ status: 'complete', outcome: 'queued' });
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'applied', 'approved']);
		const removed = await f.t.mutation(api.contracts.saveChanges, {
			membershipId: f.owner.membershipId,
			id: f.id,
			operationId: 'remove',
			commands: [
				{
					id: 'remove-command',
					itemId: f.itemId,
					expectedCurrentChangeId: current.playbook[0].currentChangeId,
					action: { kind: 'set', optionId: null },
					occurredAt: Date.now()
				}
			]
		});
		expect(removed.status).toBe('saved');
		expect((await playbookState(f)).playbook).toMatchObject([
			{
				itemId: f.itemId,
				currentOptionId: null,
				appliedOptionId: null,
				status: 'approved',
				decisionId: expect.any(String)
			}
		]);
		await f.t.mutation(api.contracts.rename, {
			membershipId: f.owner.membershipId,
			id: f.id,
			title: 'Renamed'
		});
		await f.t.mutation(api.contracts.remove, { membershipId: f.owner.membershipId, id: f.id });
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
		const contract = (await currentContract(f))!;
		expect(contract.root.title).toBe(f.creation.name);
		expect(contract.hubspot?.availability).toBe('unavailable');
		await expect(f.t.mutation(api.contracts.saveChanges, application(f))).rejects.toThrow(
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
		const contract = (await currentContract(f))!;
		expect(contract).toMatchObject({
			root: { title: 'Replacement deal' },
			hubspot: { dealId: '202', generation: 2, availability: 'available' }
		});
		expect(await events(f)).toHaveLength(1);
		await f.t.mutation(api.contracts.saveChanges, application(f));
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
