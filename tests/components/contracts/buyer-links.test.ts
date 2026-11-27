import { draft, settle, fixture, buyerLinkFixture } from './fixtures';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../src/convex/_generated/dataModel';
import { DraftJournal } from '../../../src/lib/contract/draft-recovery.svelte';
import { deferred } from '../../support/transport';

describe('buyer link preparation', () => {
	it('copies an existing clean link through one request without opening its editor or loading its template', async () => {
		const f = fixture();
		const b = buyerLinkFixture(f.owner, f.current);
		const capture = deferred<unknown>();
		b.query.mockReturnValue(capture.promise as ReturnType<typeof b.query>);
		const copying = b.links.copy();
		await settle();
		expect(b.query).toHaveBeenCalledOnce();
		expect(getFunctionName(b.query.mock.calls[0][0])).toBe('contracts:state');
		expect(b.query.mock.calls[0][1]).toEqual({ id: 'contract-a' });
		expect(f.client.onUpdate).not.toHaveBeenCalled();
		expect(f.cache.loadFrozenVersion).not.toHaveBeenCalled();
		expect(f.client.mutation).not.toHaveBeenCalled();
		expect(b.writeText).not.toHaveBeenCalled();
		capture.resolve({
			...f.current(),
			buyerName: null,
			requestDelivery: null,
			buyerLink: {
				id: b.latest.id,
				token: b.latest.token,
				createdAt: b.latest.createdAt,
				contentRevision: 0,
				concessions: {}
			},
			hasUnreadComment: false
		});
		await copying;
		await settle();
		expect(b.query).toHaveBeenCalledOnce();
		expect(b.action).not.toHaveBeenCalled();
		expect(b.writeText).toHaveBeenCalledExactlyOnceWith(`${location.origin}/${b.latest.token}`);
		expect(b.onCopied).toHaveBeenCalledOnce();
		expect(f.cache.loadFrozenVersion).not.toHaveBeenCalled();
		expect(f.owner.entries).toHaveLength(0);
	});
	it.each([
		{ source: 'local', outcome: 'saved' },
		{ source: 'recovered', outcome: 'saved' },
		{ source: 'recovered', outcome: 'failed' }
	])(
		'guards first-link creation for a $source draft when saving is $outcome',
		async ({ source, outcome }) => {
			const f = fixture();
			if (source === 'local') {
				const a = f.owner.acquire('contract-a');
				await settle();
				a.editor.persistence!.setOption('item-a' as Id<'playbookItems'>, 'preferred');
				await settle();
				a.release();
			} else {
				// The link reservation itself must discover this unopened draft.
				new DraftJournal('user', 'contract-a', 'membership').write(draft());
			}
			const b = buyerLinkFixture(f.owner, f.current);
			const copying = b.links.copy();
			await settle();
			expect(b.query).toHaveBeenCalledOnce();
			expect(getFunctionName(b.query.mock.calls[0][0])).toBe('contracts:state');
			expect(f.writes).toHaveLength(1);
			expect(b.action).not.toHaveBeenCalled();
			expect(b.writeText).not.toHaveBeenCalled();
			if (outcome === 'failed') f.writes[0].result.reject(new Error('Save failed'));
			else f.ack();
			await copying;
			await settle();
			if (outcome === 'failed') {
				expect(b.links.error).toBe('Resolve unsaved changes before continuing.');
				expect(b.action).not.toHaveBeenCalled();
				expect(b.writeText).not.toHaveBeenCalled();
				expect(b.onCopied).not.toHaveBeenCalled();
				expect(f.owner.pending).toBe(true);
			} else {
				expect(b.action).toHaveBeenCalledOnce();
				expect(b.action.mock.calls[0][1]).toMatchObject({
					membershipId: 'membership',
					id: 'contract-a',
					operationId: expect.any(String),
					expectedStateRevision: 2
				});
				expect(b.writeText).toHaveBeenCalledExactlyOnceWith(`${location.origin}/${b.latest.token}`);
				expect(b.onCopied).toHaveBeenCalledOnce();
				expect(b.links.error).toBeNull();
			}
		}
	);
	it('retains a timed-out operation for retry and waits for another click before copying a late result', async () => {
		vi.useFakeTimers();
		const f = fixture();
		const b = buyerLinkFixture(f.owner, f.current);
		const capture = deferred<typeof b.latest>();
		b.action.mockReturnValue(capture.promise);
		const first = b.links.copy();
		await vi.advanceTimersByTimeAsync(20_001);
		await first;
		expect(b.links.error).toBe('We couldn’t prepare the link. Try again.');
		expect(b.links.busy).toBeNull();
		const retry = b.links.copy();
		expect(b.action).toHaveBeenCalledTimes(2);
		expect(b.action.mock.calls[1][1]).toEqual(b.action.mock.calls[0][1]);
		await vi.advanceTimersByTimeAsync(20_001);
		await retry;
		capture.resolve(b.latest);
		await settle();
		expect(b.writeText).not.toHaveBeenCalled();
		expect(b.onCopied).not.toHaveBeenCalled();
		expect(b.links.error).toBe('We couldn’t prepare the link. Try again.');
		await b.links.copy();
		expect(b.action).toHaveBeenCalledTimes(2);
		expect(b.query).toHaveBeenCalledTimes(1);
		expect(b.writeText).toHaveBeenCalledExactlyOnceWith(`${location.origin}/${b.latest.token}`);
		expect(b.onCopied).toHaveBeenCalledOnce();
		expect(b.links.error).toBeNull();
	});
});
