import { contract, headsAfter, template, draft, controllers, settle, fixture } from './fixtures';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../src/convex/_generated/dataModel';
import { AccountLifecycle } from '../../../src/lib/auth/account-lifecycle.svelte';
import { DraftJournal } from '../../../src/lib/contract/draft-recovery.svelte';
import type { TemplateContent } from '../../../src/lib/template/model';
import { deferred } from '../../support/transport';

describe('recovery and account exits', () => {
	it('resumes account-exit saving after auth loading clears without a scope update', async () => {
		const signOut = vi.fn(async () => {});
		const controller = new AccountLifecycle({
			signOut,
			login: async () => {},
			clear() {},
			cancelReads() {}
		});
		controllers.push(controller);
		controller.identity('session', 'user', true);
		controller.reportAuth(false, true);
		controller.reportAccount(true);
		const f = fixture({ controller });
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.setOption('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		const original = f.writes[0].request;
		const exiting = controller.signOut();
		await settle();
		controller.reportAuth(true, true);
		await settle();
		await exiting;
		expect(f.owner.accessAvailable).toBe(false);
		expect(signOut).not.toHaveBeenCalled();
		expect(f.owner.pending).toBe(true);
		controller.reportAuth(false, true);
		await settle();
		expect(f.owner.accessAvailable).toBe(true);
		expect(f.client.onUpdate.mock.calls.map(([ref]) => getFunctionName(ref))).toEqual([
			'contractDefinitions:current',
			'contracts:state',
			'contractDefinitions:current',
			'contracts:state'
		]);
		expect(f.writes[1].request).toEqual(original);
		const retry = controller.signOut();
		await settle();
		f.ack(1);
		await settle();
		await retry;
		expect(signOut).toHaveBeenCalledOnce();
		expect(f.owner.pending).toBe(false);
		f.ack(0);
		await settle();
		expect(f.owner.pending).toBe(false);
	});
	it('retains immutable journal operation and command IDs through failed initialization, logout and retry', async () => {
		vi.useFakeTimers();
		const recovery = draft();
		recovery.commands[0].id = 'original-command-identity';
		recovery.request!.commands = structuredClone(recovery.commands);
		new DraftJournal('user', 'contract-a', 'membership').write(recovery);
		const f = fixture({ approval: true, read: false });
		expect(f.aggregate.pending).toBe(true);
		const flushed = f.aggregate.prepareToLeave();
		await settle();
		await vi.advanceTimersByTimeAsync(15_001);
		await settle();
		expect(await flushed).toBe(false);
		expect(f.aggregate.pending).toBe(true);
		expect(f.feedback.statusFor('contract-a')).toBe('Save failed');
		expect(f.active()).toBe(0);
		expect(new DraftJournal('user', 'contract-a', 'membership').read()?.request?.operationId).toBe(
			'original-operation'
		);
		f.setRead(true);
		f.aggregate.retry();
		await settle();
		expect(f.writes).toHaveLength(1);
		expect(f.writes[0].request.operationId).toBe('original-operation');
		expect(f.writes[0].request.commands[0].id).toBe('original-command-identity');
		expect(f.writes[0].request.commands[0]).toEqual(recovery.commands[0]);
		expect(f.owner.entries[0].snapshot).toBeUndefined();
		f.ack();
		await settle();
		expect(await f.aggregate.prepareToLeave()).toBe(true);
	});
	it('bounds recovered initialization, with foreground work allowed immediately', async () => {
		for (let i = 0; i < 8; i++)
			new DraftJournal('user', `recovered-${i}`, 'membership').write(draft(`recovered-${i}`));
		const f = fixture();
		const reads: ReturnType<typeof deferred<TemplateContent>>[] = [];
		f.cache.loadFrozenVersion.mockImplementation(() => {
			const read = deferred<TemplateContent>();
			reads.push(read);
			return read.promise;
		});
		await settle();
		expect(f.owner.entries.filter((entry) => entry.initializing)).toHaveLength(2);
		expect(f.active()).toBe(2);
		const foreground = f.owner.acquire('foreground');
		await settle();
		expect(reads).toHaveLength(3);
		reads[0].resolve(template());
		await settle();
		expect(reads).toHaveLength(4);
		expect(
			f.owner.entries.filter((entry) => entry.id.startsWith('recovered-') && entry.initializing)
		).toHaveLength(2);
		foreground.release();
	});
	it('compacts failed work and retries it with the same immutable request', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.setOption('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		a.release();
		f.writes[0].result.reject(new Error('Offline'));
		await settle();
		expect(f.active()).toBe(0);
		expect(a.editor.snapshot).toBeUndefined();
		expect(f.feedback.statusFor('contract-a')).toBe('Save failed');
		f.owner.retry('contract-a');
		await settle();
		expect(f.writes).toHaveLength(2);
		expect(f.writes[1].request).toEqual(f.writes[0].request);
		f.ack(1);
		await settle();
		expect(f.owner.entries).toHaveLength(0);
	});
	it('reconciles replaced transport before replay, ignoring late callbacks', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.setOption('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		const request = f.writes[0].request;
		f.owner.configure(false, true, 1);
		a.release();
		await settle();
		expect(f.active()).toBe(0);
		expect(f.owner.pending).toBe(true);
		f.setState(
			'contract-a',
			contract('contract-a', 2, headsAfter([], request.commands), request.operationId)
		);
		f.owner.configure(true, false, 1);
		await settle();
		expect(f.writes).toHaveLength(1);
		expect(f.owner.pending).toBe(false);
		f.ack(0);
		await settle();
		expect(f.owner.pending).toBe(false);
		expect(f.owner.entries).toHaveLength(0);
	});
	it('pauses company holds and flushes pending work with editing frozen', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		f.owner.configure(false, true, 0);
		f.aggregate.resume();
		await settle();
		expect(f.owner.accessAvailable).toBe(false);
		expect(f.active()).toBe(0);
		// Previously checkpointed intent is discovered while the company is paused.
		new DraftJournal('user', 'contract-b', 'membership').write(draft('contract-b'));
		const b = f.owner.acquire('contract-b');
		expect(b.editor.pending).toBe(true);
		expect(f.writes).toHaveLength(0);
		f.owner.configure(true, true, 0);
		await settle();
		expect(b.editor.persistence!.editable).toBe(false);
		expect(f.writes).toHaveLength(1);
		const flushed = f.aggregate.prepareToLeave();
		f.ack();
		await settle();
		expect(await flushed).toBe(true);
		a.release();
		b.release();
	});
	it('keeps conflict intent and stops detached subscriptions', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.setOption('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		const remote = contract('contract-a', 2, [], 'other-operation');
		f.publish('contract-a', remote);
		f.writes[0].result.resolve({ status: 'conflict', state: remote });
		a.release();
		await settle();
		expect(f.feedback.statusFor('contract-a')).toBe('Conflict');
		expect(f.active()).toBe(0);
		expect(a.editor.snapshot).toBeUndefined();
		const reopened = f.owner.acquire('contract-a');
		await settle();
		expect(reopened.editor.persistence!.choices).toEqual({
			['item-a' as Id<'playbookItems'>]: 'preferred'
		});
		reopened.editor.persistence!.applyRecovered();
		await settle();
		expect(f.writes[1].request.commands[0].expectedCurrentChangeId).toBeNull();
		expect(f.writes[1].request.operationId).not.toBe(f.writes[0].request.operationId);
	});
	it('explicit discard invalidates late responses and clears the journal', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.setOption('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		a.release();
		f.aggregate.discard();
		await settle();
		f.ack();
		await settle();
		expect(f.owner.entries).toHaveLength(0);
		expect(new DraftJournal('user', 'contract-a', 'membership').read()).toBeNull();
		expect(f.writes).toHaveLength(1);
		expect(f.feedback.statusFor('contract-a')).toBeUndefined();
	});
	it('coordinates confirmed deletion and retains intent after failed deletion', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.setOption('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		a.release();
		const removing = f.owner.remove('contract-a' as Id<'savedContracts'>);
		f.removal.resolve(null);
		await removing;
		await settle();
		expect(f.cache.remove).toHaveBeenCalledWith('contract-a');
		expect(new DraftJournal('user', 'contract-a', 'membership').read()).toBeNull();
		const g = fixture();
		const b = g.owner.acquire('contract-b');
		await settle();
		b.editor.persistence!.setOption('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		b.release();
		const failed = g.owner.remove('contract-b' as Id<'savedContracts'>);
		const rejected = expect(failed).rejects.toThrow('Delete failed');
		g.removal.reject(new Error('Delete failed'));
		await rejected;
		await settle();
		expect(b.editor.pending).toBe(true);
		expect(new DraftJournal('user', 'contract-b', 'membership').read()).not.toBeNull();
		expect(g.writes.at(-1)!.request.operationId).toBe(g.writes[0].request.operationId);
	});
});
