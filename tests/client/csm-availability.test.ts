import { afterEach, expect, it, vi } from 'vitest';
import {
	CsmAvailability,
	type Availability,
	type CalendarSelection
} from '../../src/lib/components/chrome/csm-availability';
import { ReadAttempt, waitForRead } from '../../src/lib/auth/attempt';
const selection: CalendarSelection = { mode: 'setup', month: '2026-11', timeZone: 'UTC' };
const ready: Availability = { status: 'ready', slots: [], duration: 30, lastDate: null };
function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
afterEach(() => vi.useRealTimers());
it('coalesces upload, expansion and opening; retains empty months for two minutes from completion', async () => {
	vi.useFakeTimers();
	const pending = deferred<Availability>(),
		load = vi.fn(() => pending.promise);
	const resource = new CsmAvailability(load, () => true);
	const reads = [resource.read(selection), resource.read(selection), resource.read(selection)];
	await Promise.resolve();
	expect(load).toHaveBeenCalledTimes(1);
	vi.advanceTimersByTime(30_000);
	pending.resolve(ready);
	await Promise.all(reads);
	vi.advanceTimersByTime(119_999);
	expect(resource.peek(selection)).toEqual(ready);
	vi.advanceTimersByTime(1);
	expect(resource.peek(selection)).toBeUndefined();
	await resource.read(selection);
	expect(load).toHaveBeenCalledTimes(2);
});
it('retains A→B→A but evicts least recently used entries beyond eight', async () => {
	const load = vi.fn(async () => ready),
		resource = new CsmAvailability(load, () => true);
	await resource.read(selection);
	const other = { ...selection, timeZone: 'Europe/London' };
	await resource.read(other);
	await resource.read(selection);
	expect(load).toHaveBeenCalledTimes(2);
	for (let index = 0; index < 7; index++)
		await resource.read({ ...selection, month: String(index) });
	expect(resource.peek(selection)).toEqual(ready);
	expect(resource.peek(other)).toBeUndefined();
});
it('evicts errors and unavailable responses so explicit intent can retry', async () => {
	const load = vi
		.fn<() => Promise<Availability>>()
		.mockRejectedValueOnce(new Error('failure'))
		.mockResolvedValueOnce({ ...ready, status: 'unavailable' })
		.mockResolvedValue(ready);
	const resource = new CsmAvailability(load, () => true);
	await expect(resource.read(selection)).rejects.toThrow('failure');
	await resource.read(selection);
	expect(resource.peek(selection)).toBeUndefined();
	await resource.read(selection);
	expect(load).toHaveBeenCalledTimes(3);
});
it('prevents late work from restoring invalidated, evicted or disposed entries', async () => {
	const pending = deferred<Availability>(),
		next = deferred<Availability>();
	const load = vi.fn().mockReturnValueOnce(pending.promise).mockReturnValue(next.promise);
	const resource = new CsmAvailability(load, () => true);
	const old = resource.read(selection);
	await Promise.resolve();
	resource.invalidate();
	const replacement = resource.read(selection);
	await Promise.resolve();
	pending.resolve(ready);
	await old;
	expect(resource.peek(selection)).toBeUndefined();
	next.resolve({ ...ready, duration: 45 });
	await replacement;
	expect(resource.peek(selection)?.duration).toBe(45);
	resource.dispose();
	expect(resource.peek(selection)).toBeUndefined();
	await expect(resource.read(selection)).rejects.toThrow('Workspace changed');
	const delayed = deferred<Availability>();
	const evicted = new CsmAvailability(
		() => delayed.promise,
		() => true
	);
	const first = evicted.read(selection);
	await Promise.resolve();
	for (let index = 0; index < 8; index++) void evicted.read({ ...selection, month: String(index) });
	delayed.resolve(ready);
	await first;
	expect(evicted.peek(selection)).toBeUndefined();
	const late = deferred<Availability>();
	const disposed = new CsmAvailability(
		() => late.promise,
		() => true
	);
	const accepted = disposed.read(selection);
	await Promise.resolve();
	disposed.dispose();
	late.resolve(ready);
	await accepted;
	expect(disposed.peek(selection)).toBeUndefined();
});
it('rejects unsafe owners and does not publish accepted late results after owner replacement', async () => {
	let current = true;
	const pending = deferred<Availability>();
	const resource = new CsmAvailability(
		() => pending.promise,
		() => current
	);
	const read = resource.read(selection);
	await Promise.resolve();
	current = false;
	pending.resolve(ready);
	await read;
	current = true;
	expect(resource.peek(selection)).toBeUndefined();
});
it('a terminal waiter deadline leaves accepted work reusable and filters elapsed starts immutably', async () => {
	vi.useFakeTimers();
	const pending = deferred<Availability>();
	const resource = new CsmAvailability(
		() => pending.promise,
		() => true
	);
	const attempt = new ReadAttempt(100);
	const timed = waitForRead(resource.read(selection), attempt.signal);
	const rejected = expect(timed).rejects.toThrow('timed out');
	vi.advanceTimersByTime(100);
	await rejected;
	const start = new Date(Date.now() + 500).toISOString();
	const data = {
		...ready,
		slots: [{ start, end: new Date(Date.now() + 1_800_500).toISOString() }]
	};
	pending.resolve(data);
	await resource.read(selection);
	vi.advanceTimersByTime(501);
	expect(resource.peek(selection)?.slots).toEqual([]);
	expect(data.slots).toHaveLength(1);
});
