// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConvexError } from 'convex/values';
import type { ConvexClient } from 'convex/browser';
import type { Id } from '../../src/convex/_generated/dataModel';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const member = 'member-a' as Id<'memberships'>;
const attemptId = (n: number) => `${'a'.repeat(20)}${n}` as Id<'hubspotExports'>;
const prefix = `dinu:download-acks:https://performance.test:${member}:`;
const load = () => import('../../src/lib/contract/download-journal');
function clientWith(
	handler: (args: { id: string; initiatedAt: number }) => Promise<null> = async () => null
) {
	const mutation = vi.fn(async (_reference: unknown, args: { id: string; initiatedAt: number }) =>
		handler(args)
	);
	return { mutation, client: { mutation } as unknown as Pick<ConvexClient, 'mutation'> };
}
beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	localStorage.clear();
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	localStorage.clear();
});

describe('durable download acknowledgments', () => {
	it('decodes keys independently so malformed entries cannot hide later valid entries', async () => {
		localStorage.setItem(prefix + attemptId(0), '{broken');
		localStorage.setItem(
			prefix + attemptId(1),
			JSON.stringify({ id: attemptId(1), initiatedAt: 'bad' })
		);
		localStorage.setItem(
			prefix + attemptId(2),
			JSON.stringify({ id: attemptId(3), initiatedAt: NOW })
		);
		localStorage.setItem(
			prefix + attemptId(4),
			JSON.stringify({ id: attemptId(4), initiatedAt: NOW, retryAt: 'bad' })
		);
		localStorage.setItem(
			prefix + attemptId(5),
			JSON.stringify({ id: attemptId(5), initiatedAt: NOW })
		);
		const { flushDownloadAcks } = await load(),
			{ client, mutation } = clientWith();
		await flushDownloadAcks(client, member);
		expect(mutation).toHaveBeenCalledTimes(1);
		expect(mutation.mock.calls[0][1]).toEqual({
			membershipId: member,
			id: attemptId(5),
			initiatedAt: NOW
		});
		expect(localStorage.length).toBe(0);
	});
	it.each([
		'This download is unavailable.',
		'Invalid download acknowledgment.',
		{ code: 'DOWNLOAD_ACK_TERMINAL', message: 'Invalid attempt' }
	])('removes one terminal rejection and continues with the next download (%j)', async (error) => {
		const { journalDownload, flushDownloadAcks } = await load();
		journalDownload(member, attemptId(1), NOW - 1000);
		journalDownload(member, attemptId(2), NOW);
		const { client, mutation } = clientWith(async (args) => {
			if (args.id === attemptId(1)) throw new ConvexError(error);
			return null;
		});
		await flushDownloadAcks(client, member);
		expect(mutation).toHaveBeenCalledTimes(2);
		expect(localStorage.length).toBe(0);
	});
	it('filters future timestamps before the batch limit so they cannot starve valid entries', async () => {
		const { journalDownload, flushDownloadAcks } = await load();
		for (let i = 0; i < 30; i++) journalDownload(member, attemptId(i), NOW + 120_000);
		journalDownload(member, attemptId(31), NOW);
		const { client, mutation } = clientWith();
		await flushDownloadAcks(client, member);
		expect(mutation.mock.calls.map(([, args]) => args.id)).toEqual([attemptId(31)]);
		expect(localStorage.length).toBe(30);
	});
	it('persists server clock deferral across reloads without rewriting download time or blocking later entries', async () => {
		const first = await load();
		for (let i = 0; i < 26; i++) first.journalDownload(member, attemptId(i), NOW);
		const rejected = clientWith(async () => {
			throw new ConvexError({ code: 'DOWNLOAD_ACK_FUTURE', retryAfter: 120_000 });
		});
		await first.flushDownloadAcks(rejected.client, member);
		expect(rejected.mutation).toHaveBeenCalledTimes(25);
		expect(JSON.parse(localStorage.getItem(prefix + attemptId(0))!)).toEqual({
			id: attemptId(0),
			initiatedAt: NOW,
			retryAt: NOW + 120_000
		});
		vi.resetModules();
		const reloaded = await load(),
			accepted = clientWith();
		await reloaded.flushDownloadAcks(accepted.client, member);
		expect(accepted.mutation.mock.calls.map(([, args]) => args.id)).toEqual([attemptId(25)]);
		vi.setSystemTime(NOW + 120_000);
		await reloaded.flushDownloadAcks(accepted.client, member);
		expect(accepted.mutation).toHaveBeenCalledTimes(26);
		for (const [, args] of accepted.mutation.mock.calls) {
			expect(args.initiatedAt).toBe(NOW);
			expect(args).not.toHaveProperty('retryAt');
		}
		expect(localStorage.length).toBe(0);
	});
	it.each([new Error('Offline'), new ConvexError('Sign in with a verified email address.')])(
		'preserves the queue on transport/session failures for retry after reload',
		async (error) => {
			const first = await load();
			first.journalDownload(member, attemptId(1), NOW - 1000);
			first.journalDownload(member, attemptId(2), NOW);
			const failing = clientWith(async () => {
				throw error;
			});
			await first.flushDownloadAcks(failing.client, member);
			expect(failing.mutation).toHaveBeenCalledTimes(1);
			expect(localStorage.length).toBe(2);
			vi.resetModules();
			const reloaded = await load(),
				accepted = clientWith();
			await reloaded.flushDownloadAcks(accepted.client, member);
			expect(accepted.mutation.mock.calls.map(([, args]) => args.initiatedAt)).toEqual([
				NOW - 1000,
				NOW
			]);
			expect(localStorage.length).toBe(0);
		}
	);
	it('isolates members and deployments and preserves another tab’s per-download key', async () => {
		const { journalDownload, flushDownloadAcks } = await load();
		journalDownload(member, attemptId(1), NOW);
		localStorage.setItem(
			prefix + attemptId(2),
			JSON.stringify({ id: attemptId(2), initiatedAt: NOW - 1000 })
		);
		const foreignMember = prefix.replace('member-a', 'member-b') + attemptId(3);
		const foreignDeployment = prefix.replace('performance.test', 'other.test') + attemptId(4);
		for (const key of [foreignMember, foreignDeployment])
			localStorage.setItem(key, JSON.stringify({ id: attemptId(3), initiatedAt: NOW }));
		const { client, mutation } = clientWith();
		await flushDownloadAcks(client, member);
		expect(mutation.mock.calls.map(([, args]) => args.id)).toEqual([attemptId(1), attemptId(2)]);
		expect(localStorage.length).toBe(2);
		expect(localStorage.getItem(foreignMember)).not.toBeNull();
		expect(localStorage.getItem(foreignDeployment)).not.toBeNull();
	});
	it('prevents overlapping flushes and keeps new downloads queued during an in-flight acknowledgment', async () => {
		const { journalDownload, flushDownloadAcks } = await load();
		journalDownload(member, attemptId(1), NOW);
		let release!: (value: null) => void;
		const pending = new Promise<null>((resolve) => {
			release = resolve;
		});
		const { client, mutation } = clientWith(() => pending);
		const first = flushDownloadAcks(client, member);
		await flushDownloadAcks(client, member);
		journalDownload(member, attemptId(2), NOW);
		expect(mutation).toHaveBeenCalledTimes(1);
		release(null);
		await first;
		expect(localStorage.getItem(prefix + attemptId(2))).not.toBeNull();
		await flushDownloadAcks(client, member);
		expect(mutation).toHaveBeenCalledTimes(2);
	});
	it('can acknowledge from memory when browser storage is unavailable', async () => {
		const { journalDownload, flushDownloadAcks } = await load();
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('Storage disabled');
		});
		journalDownload(member, attemptId(1), NOW);
		const { client, mutation } = clientWith();
		await flushDownloadAcks(client, member);
		expect(mutation.mock.calls.map(([, args]) => args.id)).toEqual([attemptId(1)]);
		await flushDownloadAcks(client, member);
		expect(mutation).toHaveBeenCalledTimes(1);
	});
});
