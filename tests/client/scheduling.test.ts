import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentScheduler } from '../../src/lib/document/runtime/scheduler';

describe('scheduling work', () => {
	let scheduler: DocumentScheduler;
	let idle: Map<number, IdleRequestCallback>;

	beforeEach(() => {
		vi.useFakeTimers();
		idle = new Map();
		let nextId = 0;
		vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false }));
		vi.stubGlobal('window', {
			requestIdleCallback: (callback: IdleRequestCallback) => {
				idle.set(++nextId, callback);
				return nextId;
			},
			cancelIdleCallback: (id: number) => idle.delete(id)
		});
		scheduler = new DocumentScheduler();
	});

	function dispatchIdle() {
		const callbacks = [...idle.values()];
		idle.clear();
		for (const callback of callbacks) callback({ didTimeout: false, timeRemaining: () => 10 });
	}

	afterEach(() => {
		scheduler.destroy();
		try {
			expect(idle.size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
			vi.unstubAllGlobals();
		}
	});

	it('dispatches foreground ahead of previously queued background work', async () => {
		const order: string[] = [];
		const background = scheduler.run(
			() => 'background',
			() => order.push('background')
		);
		const foreground = scheduler.run(
			() => 'foreground',
			() => order.push('foreground')
		);
		// Explicitly run the browser's next callbacks, whichever mechanism it chose.
		await vi.runOnlyPendingTimersAsync();
		dispatchIdle();
		await vi.runOnlyPendingTimersAsync();
		dispatchIdle();
		await Promise.all([foreground, background]);
		expect(order).toEqual(['foreground', 'background']);
	});

	it('rejects aborted queued work without executing its callback', async () => {
		const controller = new AbortController();
		const work = vi.fn();
		const pending = scheduler.run(() => 'background', work, controller.signal);
		const reason = new Error('Cancelled queued work.');
		const rejected = expect(pending).rejects.toBe(reason);
		controller.abort(reason);
		await rejected;
		dispatchIdle();
		await vi.runAllTimersAsync();
		expect(work).not.toHaveBeenCalled();
	});

	it('rejects all queued work and cancels dispatch when destroyed', async () => {
		const work = vi.fn();
		const background = scheduler.run(() => 'background', work);
		const foreground = scheduler.run(() => 'foreground', work);
		const rejected = Promise.all([
			expect(background).rejects.toThrow('Document scheduler released.'),
			expect(foreground).rejects.toThrow('Document scheduler released.')
		]);
		scheduler.destroy();
		await rejected;
		dispatchIdle();
		await vi.runAllTimersAsync();
		expect(work).not.toHaveBeenCalled();
	});
});
