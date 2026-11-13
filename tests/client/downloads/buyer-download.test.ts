// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuyerDownload } from '../../../src/lib/buyer/download.svelte';
import { downloadWord } from '../../../src/lib/document/export/download';
import { deferred } from '../../support/transport';

vi.mock('../../../src/lib/document/export/download', () => ({ downloadWord: vi.fn() }));
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});
const response = () =>
	new Response(new Blob(['docx']), {
		headers: { 'Content-Disposition': "attachment; filename*=UTF-8''Caf%C3%A9%20Contract.docx" }
	});
function fixture() {
	const state = {
		allowed: true,
		foreground: true,
		connected: true,
		displayed: { displayIdentity: 'a'.repeat(64) }
	};
	const result = deferred<Response>();
	const fetcher = vi.fn(() => result.promise);
	vi.stubGlobal('fetch', fetcher);
	return { state, result, fetcher, download: new BuyerDownload('0'.repeat(39), state) };
}
describe('buyer download ownership', () => {
	it('posts the displayed identity and triggers one download with the decoded filename', async () => {
		const f = fixture();
		const pending = f.download.start();
		await f.download.start();
		expect(f.fetcher).toHaveBeenCalledTimes(1);
		expect(f.fetcher).toHaveBeenCalledWith(
			`/api/buyer/${'0'.repeat(39)}/download`,
			expect.objectContaining({
				method: 'POST',
				cache: 'no-store',
				body: JSON.stringify({ displayIdentity: f.state.displayed.displayIdentity })
			})
		);
		f.result.resolve(response());
		await pending;
		expect(downloadWord).toHaveBeenCalledWith(expect.any(Blob), 'Café Contract.docx');
		f.download.destroy();
	});
	it.each([
		'new display',
		'background',
		'disconnected',
		'permission lost',
		'destroyed',
		'reset'
	] as const)('ignores a completed request after %s', async (change) => {
		const f = fixture();
		const pending = f.download.start();
		if (change === 'new display') f.state.displayed = { displayIdentity: 'b'.repeat(64) };
		if (change === 'background') f.state.foreground = false;
		if (change === 'disconnected') f.state.connected = false;
		if (change === 'permission lost') f.state.allowed = false;
		if (change === 'destroyed') f.download.destroy();
		if (change === 'reset') f.download.reset();
		f.result.resolve(response());
		await pending;
		expect(downloadWord).not.toHaveBeenCalled();
		f.download.destroy();
	});
	it('times out a hung request, ignores its late response, and allows a fresh retry', async () => {
		const f = fixture();
		const pending = f.download.start();
		await vi.advanceTimersByTimeAsync(60_001);
		await pending;
		expect(f.download.error).toContain('couldn’t download');
		f.result.resolve(response());
		await Promise.resolve();
		expect(downloadWord).not.toHaveBeenCalled();
		f.fetcher.mockResolvedValueOnce(response());
		await f.download.start();
		expect(downloadWord).toHaveBeenCalledTimes(1);
		expect(f.download.error).toBeNull();
		f.download.destroy();
	});
});
