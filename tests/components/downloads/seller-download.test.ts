import { getFunctionName } from 'convex/server';
import { ConvexError } from 'convex/values';
import { mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContractEditor } from '../../../src/lib/contract/editors.svelte';
import Workspace from '../../../src/lib/components/workspace/RepWorkspace.svelte';
import { downloadWord } from '../../../src/lib/document/export/download';
import { journalDownload } from '../../../src/lib/contract/download-journal';
import { downloadState } from './download-state.svelte';
import { deferred } from '../../support/transport';
import { settle } from '../../support/svelte';
import { navigating } from '../../support/navigation.svelte';

const context = vi.hoisted(() => ({ client: undefined as unknown, state: undefined as unknown }));
const current = () => context.state as ReturnType<typeof downloadState>['state'];
vi.mock('convex-svelte', () => ({
	useConvexClient: () => context.client,
	useQuery: () => ({ data: { summary: { pendingCount: 0, declinedCount: 0 }, request: null } })
}));
vi.mock('$lib/auth/account-context.svelte', () => ({ useAccountContext: () => current().auth }));
vi.mock('$lib/auth/viewer-session.svelte', () => ({
	useViewerSession: () => current().session,
	useViewer: () => () => ({
		membership: { id: 'member', role: 'admin' },
		company: { id: 'company' }
	})
}));
vi.mock('$lib/auth/workspace-context.svelte', () => ({
	getWorkspaceRuntime: () => current().runtime
}));
vi.mock('$lib/hubspot-deals.svelte', () => ({
	useHubSpotDeals: () => ({ connection: { data: { status: 'uninstalled' } } })
}));
vi.mock('$lib/auth/read-query.svelte', () => ({
	useReadQuery: (ref: Parameters<typeof getFunctionName>[0]) =>
		getFunctionName(ref) === 'contractExports:status' ? current().status : { data: null }
}));
vi.mock('$lib/contract/snapshot-cache', () => ({ getContractOpenings: () => ({ record() {} }) }));
vi.mock('$lib/document/runtime/resources.svelte', () => ({
	getDocumentResources: () => undefined
}));
vi.mock('$lib/document/runtime/workspace-factory', () => ({
	createDocumentWorkspace: () => ({
		source: { items: [], renderSource: null },
		renderer: {},
		viewer: {},
		accept() {}
	})
}));
vi.mock('$lib/contract/review-pages.svelte', () => ({
	ContractReviewPages: class {
		rows = [];
		done = true;
		destroy() {}
	}
}));
vi.mock(
	'$lib/components/document/DocumentViewerSlot.svelte',
	() => import('./DownloadViewer.svelte')
);
vi.mock(
	'$lib/components/workspace/WorkspaceChrome.svelte',
	() => import('./DownloadChrome.svelte')
);
vi.mock('$lib/buyer/BuyerLinkBar.svelte', () => import('./DownloadEmpty.svelte'));
vi.mock('$lib/components/playbook/BoxDismissal.svelte', () => import('./DownloadEmpty.svelte'));
vi.mock('$lib/document/export/download', () => ({ downloadWord: vi.fn() }));
vi.mock('$lib/contract/download-journal', () => ({
	journalDownload: vi.fn(),
	flushDownloadAcks: vi.fn(async () => {})
}));

let mounted: ReturnType<typeof mount> | undefined;
beforeEach(() => {
	vi.useFakeTimers();
	navigating.to = null;
});
afterEach(async () => {
	if (mounted) await unmount(mounted);
	mounted = undefined;
	document.body.innerHTML = '';
	vi.clearAllTimers();
	vi.useRealTimers();
});
const output = {
	url: 'https://storage.test/document',
	filename: 'Contract.docx',
	attemptId: 'a'.repeat(32)
};
async function fixture() {
	const f = downloadState();
	context.state = f.state;
	const action = vi.fn().mockResolvedValue(output);
	const query = vi.fn(async () => f.state.status.data);
	context.client = {
		action,
		query,
		connectionState: () => ({ isWebSocketConnected: true }),
		subscribeToConnectionState: () => () => {},
		mutation: vi.fn(async () => null)
	};
	const fetcher = vi.fn(async () => new Response(new Blob(['real download bytes'])));
	vi.stubGlobal('fetch', fetcher);
	mounted = mount(Workspace, {
		target: document.body,
		props: {
			snapshot: f.ready.snapshot,
			editor: f.editor as unknown as ContractEditor,
			onRetry() {}
		}
	});
	await settle();
	return { ...f, action, query, fetcher };
}
function click(label = 'Download as .docx') {
	const button = [...document.querySelectorAll('button')].find(
		(button) => button.textContent?.trim() === label
	);
	expect(button, document.body.textContent ?? '').toBeDefined();
	expect(button!.disabled).toBe(false);
	button!.click();
}
async function until(condition: () => boolean) {
	for (let i = 0; i < 50; i++) {
		await settle();
		if (condition()) return;
	}
	expect(condition(), document.body.textContent ?? '').toBe(true);
}

describe('seller Word download wiring', () => {
	it('waits for saving, retries OUTPUT_PENDING with the same identity, and acknowledges only after download', async () => {
		const f = await fixture();
		const saving = deferred<boolean>();
		f.savePending.mockReturnValueOnce(saving.promise);
		f.action.mockRejectedValueOnce(
			new ConvexError({ code: 'OUTPUT_PENDING', message: 'Preparing' })
		);
		const file = deferred<Response>();
		f.fetcher.mockReturnValueOnce(file.promise);
		click();
		await settle();
		expect(f.action).not.toHaveBeenCalled();
		saving.resolve(true);
		await settle();
		expect(f.action).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(250);
		await settle();
		expect(f.action).toHaveBeenCalledTimes(2);
		expect(f.action.mock.calls[1]).toEqual(f.action.mock.calls[0]);
		expect(downloadWord).not.toHaveBeenCalled();
		expect(journalDownload).not.toHaveBeenCalled();
		file.resolve(new Response(new Blob(['docx'])));
		await settle();
		expect(downloadWord).toHaveBeenCalledWith(expect.any(Blob), output.filename);
		expect(journalDownload).toHaveBeenCalledWith('member', output.attemptId, expect.any(Number));
		expect(vi.mocked(downloadWord).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(journalDownload).mock.invocationCallOrder[0]
		);
	});

	it('retains the original attempt after a failed fetch and starts a new identity only after successful download', async () => {
		const f = await fixture();
		f.fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
		click();
		await until(() =>
			[...document.querySelectorAll('button')].some(
				(button) => button.textContent === 'Retry download'
			)
		);
		expect(journalDownload).not.toHaveBeenCalled();
		click('Retry download');
		await until(() => vi.mocked(journalDownload).mock.calls.length === 1);
		expect(f.action.mock.calls[1]).toEqual(f.action.mock.calls[0]);
		expect(downloadWord).toHaveBeenCalledTimes(1);
		expect(journalDownload).toHaveBeenCalledTimes(1);
		click();
		await until(() => f.action.mock.calls.length === 3);
		expect(f.action.mock.calls[2][1].operationId).not.toBe(f.action.mock.calls[0][1].operationId);
	});

	it('times out stalled generation, retries the same attempt, and ignores its late first result', async () => {
		const f = await fixture();
		const first = deferred<typeof output>();
		f.action.mockReturnValueOnce(first.promise);
		click();
		await until(() => f.action.mock.calls.length === 1);
		await vi.advanceTimersByTimeAsync(30_001);
		await until(() =>
			[...document.querySelectorAll('button')].some(
				(button) => button.textContent === 'Retry download'
			)
		);
		expect(downloadWord).not.toHaveBeenCalled();
		expect(journalDownload).not.toHaveBeenCalled();
		click('Retry download');
		await until(() => vi.mocked(journalDownload).mock.calls.length === 1);
		expect(f.action.mock.calls[1]).toEqual(f.action.mock.calls[0]);
		first.resolve(output);
		await settle();
		expect(f.fetcher).toHaveBeenCalledTimes(1);
		expect(downloadWord).toHaveBeenCalledTimes(1);
		expect(journalDownload).toHaveBeenCalledTimes(1);
	});

	it.each(['navigation', 'session replaced', 'approval lost', 'unmounted'] as const)(
		'does not download or acknowledge late bytes after %s',
		async (change) => {
			const f = await fixture();
			const file = deferred<Response>();
			f.fetcher.mockReturnValueOnce(file.promise);
			click();
			await settle();
			expect(f.fetcher).toHaveBeenCalledTimes(1);
			if (change === 'navigation') navigating.to = { url: new URL('https://test.local/contracts') };
			if (change === 'session replaced') f.state.session.transportGeneration++;
			if (change === 'approval lost') f.state.status.data.canExport = false;
			if (change === 'unmounted') {
				await unmount(mounted!);
				mounted = undefined;
			}
			await settle();
			file.resolve(new Response(new Blob(['late bytes'])));
			await settle();
			expect(downloadWord).not.toHaveBeenCalled();
			expect(journalDownload).not.toHaveBeenCalled();
		}
	);
});
