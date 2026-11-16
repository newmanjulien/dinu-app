import { contract, headsAfter, settle, fixture, show } from './fixtures';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../src/convex/_generated/dataModel';
import { screen } from '../../support/navigation.svelte';
import { rendering } from './rendering.svelte';

describe('route and editing lifetimes', () => {
	it('shares approved-document readiness across consumers and withholds incomplete wording', async () => {
		const f = fixture({ selectedRead: false });
		const attachment = f.owner.acquire('contract-a'),
			second = f.owner.acquire('contract-a');
		await settle();
		const editor = attachment.editor;
		expect(second.editor).toBe(editor);
		expect(editor.snapshot).toBeDefined();
		const assertReadiness = (ready: boolean) => {
			expect(editor.definitionsReady).toBe(ready);
			const input = editor.documentInput;
			expect(input.kind).toBe('records');
			expect(input.items?.data !== undefined).toBe(ready);
			for (let i = 0; i < 5; i++) {
				expect(editor.definitionsReady).toBe(ready);
				expect(editor.documentInput).toBe(input);
			}
		};
		try {
			assertReadiness(false);
			expect(f.cache.loadApproved).toHaveBeenCalledOnce();
			f.publishApproved();
			await settle();
			assertReadiness(true);
			expect(editor.documentInput.items?.data?.map((item) => item._id)).toEqual(['item-a']);
		} finally {
			attachment.release();
			second.release();
		}
	});

	it('commits Contracts while saving and reattaches one owner with local choices', async () => {
		const f = fixture();
		const target = show(f);
		await settle();
		[...target.querySelectorAll('button')]
			.find((button) => button.textContent?.trim() === 'Select concession')!
			.click();
		await settle();
		const original = f.owner.entries[0];
		expect(f.writes).toHaveLength(1);
		(target.querySelector('button') as HTMLButtonElement).click();
		await settle();
		expect(target.textContent).toContain('Contracts content');
		expect(original.pending).toBe(true);
		expect(f.active('contract-a')).toBe(1);
		screen.home = false;
		await settle();
		expect(f.owner.entries[0]).toBe(original);
		expect(target.textContent).toContain('preferred');
		expect(f.active('contract-a')).toBe(1);
		expect(f.writes).toHaveLength(1);
		f.ack();
		await settle();
		screen.home = true;
		await settle();
		expect(f.owner.entries).toHaveLength(0);
		expect(f.active()).toBe(0);
		expect(f.feedback.statusFor('contract-a')).toBe('Saved');
	});
	it('waits for the write response when metadata acknowledges first', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.setOption('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		a.release();
		const request = f.writes[0].request;
		f.publish(
			'contract-a',
			contract('contract-a', 2, headsAfter([], request.commands), request.operationId)
		);
		await settle();
		expect(a.editor.inFlight).toBe(true);
		expect(f.owner.entries).toHaveLength(1);
		expect(f.writes).toHaveLength(1);
		let completed = false;
		const flushed = f.aggregate.prepareToLeave().then((ok) => {
			completed = true;
			return ok;
		});
		await settle();
		expect(completed).toBe(false);
		f.ack();
		await settle();
		expect(await flushed).toBe(true);
		expect(f.owner.entries).toHaveLength(0);
		expect(f.active()).toBe(0);
	});
	it('saves contracts independently without a host or rendering resources', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a'),
			b = f.owner.acquire('contract-b');
		await settle();
		for (const acquired of [a, b]) {
			acquired.editor.persistence!.setOption('item-a' as Id<'playbookItems'>, 'preferred');
			acquired.release();
		}
		await settle();
		expect(f.writes).toHaveLength(2);
		f.ack(1);
		await settle();
		expect(f.owner.entries.map((entry) => entry.id)).toEqual(['contract-a']);
		f.ack(0);
		await settle();
		expect(f.owner.entries).toHaveLength(0);
	});
	it.each(['opening failure', 'rendering timeout'])(
		'retries the saved opening after %s without creating another contract',
		async (failure) => {
			const renderingTimeout = failure === 'rendering timeout';
			if (renderingTimeout) {
				vi.useFakeTimers();
				rendering.ready = false;
			}
			const f = fixture();
			if (!renderingTimeout) f.failNext();
			screen.destination = { kind: 'new' };
			const target = show(f);
			await settle();
			const name = target.querySelector('input[autocomplete="organization"]') as HTMLInputElement;
			name.value = 'Buyer';
			name.dispatchEvent(new Event('input', { bubbles: true }));
			await settle();
			(target.querySelector('button[type="submit"]') as HTMLButtonElement).click();
			await settle();
			if (renderingTimeout) {
				expect(f.active('contract-b')).toBe(1);
				await vi.advanceTimersByTimeAsync(15_001);
				await settle();
			}
			expect(target.querySelector('dialog')).toBeNull();
			expect(target.textContent).toContain(
				renderingTimeout ? 'We couldn’t refresh this contract' : 'We couldn’t load this contract'
			);
			rendering.ready = true;
			[...target.querySelectorAll('button')]
				.find((button) => button.textContent?.trim() === 'Try again')!
				.click();
			await settle();
			expect(target.querySelector('[aria-label="Contract viewer"]')).not.toBeNull();
			expect(target.textContent).not.toContain(
				'Your contract was created, but we couldn’t open it'
			);
			expect(
				f.client.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'contracts:create')
			).toHaveLength(1);
			expect(screen.destination).toEqual({ kind: 'saved', id: 'contract-b' });
			expect(f.owner.entries[0].attachments).toBe(2);
			expect(f.active('contract-b')).toBe(1);
		}
	);
	it('disposes a detached opening failure when it has no unsaved intent', async () => {
		const f = fixture();
		f.failNext();
		const acquired = f.owner.acquire('contract-a');
		await settle();
		expect(acquired.editor.error).not.toBeNull();
		expect(f.feedback.notices).toHaveLength(0);
		acquired.release();
		await settle();
		expect(f.owner.entries).toHaveLength(0);
		expect(f.active()).toBe(0);
	});
});
