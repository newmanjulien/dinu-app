import { fixtureOperationId } from '../../support/operation';
// @vitest-environment edge-runtime
import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../src/convex/_generated/dataModel';
import {
	api,
	internal,
	fixture,
	currentContract,
	playbookState,
	decision,
	application,
	events,
	integrationClock,
	markUnavailable,
	relink,
	readyExport,
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
		const args = application(f);
		await f.t.mutation(api.contracts.save, args);
		await f.t.mutation(api.contracts.save, args);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'applied']);
		const state = await f.t.query(api.contracts.state, {
			membershipId: f.owner.membershipId,
			id: f.id
		});
		expect(state?.concessions).toMatchObject([
			{
				itemId: f.itemId,
				optionId: 'preferred',
				status: 'approved'
			}
		]);
	});
	it('records an actual approval request and each explicit decision once despite replays', async () => {
		const f = await fixture();
		await f.repClient.mutation(api.contracts.save, {
			...application(f),
			membershipId: f.rep.membershipId
		});
		const state = await playbookState(f);
		const request = {
			membershipId: f.rep.membershipId,
			id: f.id,
			expectedGeneration: state.review.generation,
			operationId: fixtureOperationId('request')
		};
		const first = await f.repClient.mutation(api.approvals.request, request);
		expect(await f.repClient.mutation(api.approvals.request, request)).toEqual(first);
		const decline = await decision(f, 'decline', 'decline');
		await f.t.mutation(api.approvals.decide, decline);
		await f.t.mutation(api.approvals.decide, decline);
		const approval = await decision(f, 'approve', 'approve');
		await f.t.mutation(api.approvals.decide, approval);
		await f.t.mutation(api.approvals.decide, approval);
		expect((await events(f)).map((e) => e.kind)).toEqual([
			'created',
			'applied',
			'requested',
			'declined',
			'approved'
		]);
		expect(JSON.parse((await events(f))[2].detail)).toMatchObject({ count: 1 });
	});
	it('rolls back receipts, applications and activity when saving an invalid selection fails', async () => {
		const f = await fixture();
		const args = application(f);
		await expect(
			f.t.mutation(api.contracts.save, {
				...args,
				selections: { [f.itemId]: 'absent' } as Record<Id<'playbookItems'>, string>
			})
		).rejects.toThrow();
		expect((await events(f)).map((e) => e.kind)).toEqual(['created']);
		expect(await f.t.run(({ db }) => db.query('operationReceipts').collect())).toHaveLength(1);
		expect((await playbookState(f)).concessions).toEqual([]);
		await f.t.mutation(api.contracts.save, args);
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'applied']);
	});
	it('records no activity on conflicting saves or failed approval requests', async () => {
		const f = await fixture();
		const stale = application(f, 'stale', 99);
		expect((await f.t.mutation(api.contracts.save, stale)).status).toBe('conflict');
		const state = await playbookState(f);
		await expect(
			f.t.mutation(api.approvals.request, {
				membershipId: f.owner.membershipId,
				id: f.id,
				expectedGeneration: state.review.generation,
				operationId: fixtureOperationId('empty-request')
			})
		).rejects.toThrow('no concessions waiting for approval');
		expect((await events(f)).map((e) => e.kind)).toEqual(['created']);
	});
	it('queues review completion and records no extra activity for completion, removal, rename or deletion', async () => {
		const f = await fixture();
		await f.repClient.mutation(api.contracts.save, {
			...application(f),
			membershipId: f.rep.membershipId
		});
		const afterSave = await playbookState(f);
		await f.repClient.mutation(api.approvals.request, {
			membershipId: f.rep.membershipId,
			id: f.id,
			expectedGeneration: afterSave.review.generation,
			operationId: fixtureOperationId('request-for-completion')
		});
		await f.t.mutation(api.approvals.decide, await decision(f, 'approve', 'approve'));
		const current = await playbookState(f);
		if (current.review.completion?.kind !== 'awaitingConfirmation')
			throw new Error('Expected awaitingConfirmation completion');
		expect(
			await f.t.mutation(api.approvals.complete, {
				membershipId: f.owner.membershipId,
				id: f.id,
				expectedGeneration: current.review.generation,
				expectedDecidedAt: current.review.completion.decidedAt,
				operationId: fixtureOperationId('complete-review')
			})
		).toMatchObject({ status: 'queued' });
		expect((await events(f)).map((e) => e.kind)).toEqual([
			'created',
			'applied',
			'requested',
			'approved'
		]);
		const removed = await f.t.mutation(api.contracts.save, {
			membershipId: f.owner.membershipId,
			id: f.id,
			selections: {},
			expectedStateRevision: current.stateRevision,
			operationId: fixtureOperationId('remove')
		});
		expect(removed.status).toBe('saved');
		expect((await playbookState(f)).concessions).toEqual([]);
		await f.t.mutation(api.contracts.rename, {
			membershipId: f.owner.membershipId,
			id: f.id,
			title: 'Renamed'
		});
		await f.t.mutation(api.contracts.remove, { membershipId: f.owner.membershipId, id: f.id });
		expect((await events(f)).map((e) => e.kind)).toEqual([
			'created',
			'applied',
			'requested',
			'approved'
		]);
	});
});

describe('missing HubSpot deals and relinking', () => {
	it('blocks new work after a provider 404 while preserving the contract and earlier committed download events', async () => {
		const f = await fixture();
		await readyExport(f);
		const fetcher = vi.fn(async () => json({}, 404));
		vi.stubGlobal('fetch', fetcher);
		await send(f);
		expect(await event(f)).toMatchObject({ status: 'paused', destination: { dealId: '101' } });
		const contract = (await currentContract(f))!;
		expect(contract.root.title).toBe(f.creation.name);
		expect(contract.hubspot?.availability).toBe('unavailable');
		await expect(f.t.mutation(api.contracts.save, application(f))).rejects.toThrow(
			'Link another deal'
		);
		await expect(readyExport(f, 'blocked-download')).rejects.toThrow('Link another deal');
		expect((await events(f)).map((e) => e.kind)).toEqual(['created', 'downloaded']);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('relinks and renames the contract; new activity uses the replacement and old events/exports keep their destination', async () => {
		const f = await fixture();
		const reserved = await readyExport(f);
		await markUnavailable(f);
		const repaired = await relink(f);
		expect(await relink(f)).toEqual(repaired);
		const contract = (await currentContract(f))!;
		expect(contract).toMatchObject({
			root: { title: 'Replacement deal' },
			hubspot: { dealId: '202', generation: 2, availability: 'available' }
		});
		expect(await events(f)).toHaveLength(2);
		await f.t.mutation(api.contracts.save, application(f, 'apply', contract.root.stateRevision));
		const all = await events(f);
		expect(all.map((e) => [e.kind, e.destination.dealId])).toEqual([
			['created', '101'],
			['downloaded', '101'],
			['applied', '202']
		]);
		const download = all.find((e) => e.attemptId === reserved._id)!;
		expect(download.destination.generation).toBe(1);
		vi.advanceTimersByTime(6 * 60_000);
		await f.t.mutation(internal.hubspotDelivery.pump, {});
		expect((await events(f))[0].status).toBe('paused');
		expect((await events(f))[1].status).toBe('paused');
	});
});
