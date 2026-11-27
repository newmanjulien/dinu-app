import { mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { Id } from '../../../src/convex/_generated/dataModel';
import { reactive } from '../../support/observers.svelte';
import { settle } from '../../support/svelte';
import Harness from './BuyerLinkBarFrameHarness.svelte';

const context = vi.hoisted(() => ({
	workspace: undefined as unknown,
	runtime: undefined as unknown
}));

vi.mock('convex-svelte', () => ({ useConvexClient: () => ({}) }));
vi.mock('$lib/buyer/BuyerLinkBar.svelte', () => import('./BuyerLinkBarProbe.svelte'));
vi.mock(
	'$lib/components/workspace/RepWorkspace.svelte',
	() => import('../downloads/DownloadEmpty.svelte')
);
vi.mock(
	'$lib/components/workspace/WorkspaceDocumentFeedback.svelte',
	() => import('../downloads/DownloadEmpty.svelte')
);
vi.mock(
	'$lib/components/document/DocumentViewerSlot.svelte',
	() => import('../downloads/DownloadEmpty.svelte')
);
vi.mock('$lib/document/runtime/resources.svelte', () => ({
	getDocumentResources: () => undefined
}));
vi.mock('$lib/document/runtime/workspace-factory', () => ({
	createDocumentWorkspace: () => context.workspace
}));
vi.mock('$lib/auth/workspace-context.svelte', () => ({
	getWorkspaceRuntime: () => context.runtime
}));
vi.mock('$lib/auth/viewer-session.svelte', () => ({
	useViewerSession: () => ({ blocked: false })
}));

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
	if (component) await unmount(component);
	component = undefined;
	document.body.innerHTML = '';
});

function createFixture(options: { warm?: boolean } = {}) {
	const workspace = reactive({
		source: { renderSource: (options.warm ? {} : null) as object | null },
		viewer: {
			firstPagesReady: null as { source: object } | null,
			exactDisplay: null
		},
		renderer: {},
		accept() {}
	});
	if (options.warm && workspace.source.renderSource) {
		workspace.viewer.firstPagesReady = { source: workspace.source.renderSource };
	}
	const runtime = reactive({ paused: false });
	const state = reactive({
		interactionAdmitted: true,
		editor: {
			id: 'contract-a',
			readable: {},
			documentInput: { kind: 'records' },
			renderChoices: {},
			definitionsReady: true,
			persistence: { deleted: false, workBlock: null as string | null } as
				{ deleted: boolean; workBlock: string | null } | undefined,
			buyerLink: null as null | {
				id: Id<'buyerLinks'>;
				token: string;
				createdAt: number;
				contentRevision: number;
				concessions: Record<string, string>;
			},
			hasUnreadComment: false
		}
	});
	context.workspace = workspace;
	context.runtime = runtime;
	component = mount(Harness, {
		target: document.body,
		props: {
			editor: state.editor,
			get interactionAdmitted() {
				return state.interactionAdmitted;
			}
		}
	});
	return { workspace, runtime, state };
}

it('shows a warm saved footer in the first settled render when first pages and persistence are ready', async () => {
	createFixture({ warm: true });
	await settle();
	expect(document.querySelector('[data-buyer-link-bar="contract-a"]')).not.toBeNull();
});

it('admits the saved footer after matching first pages, retains it through later page batches, and follows interaction admission', async () => {
	const { workspace, state } = createFixture();
	const bar = () => document.querySelector('[data-buyer-link-bar]');
	await settle();
	expect(bar()).toBeNull();

	const currentSource = {};
	workspace.source.renderSource = currentSource;
	workspace.viewer.firstPagesReady = { source: {} };
	await settle();
	expect(bar()).toBeNull();

	workspace.viewer.firstPagesReady = { source: workspace.source.renderSource };
	await settle();
	const firstBar = bar();
	expect(firstBar?.getAttribute('data-buyer-link-bar')).toBe('contract-a');

	workspace.viewer.firstPagesReady = null;
	workspace.source.renderSource = {};
	await settle();
	expect(bar()).toBe(firstBar);

	state.interactionAdmitted = false;
	await settle();
	expect(bar()).toBeNull();

	state.interactionAdmitted = true;
	await settle();
	expect(bar()).not.toBeNull();
});

it('withholds the footer when work-blocked without a buyer link, but keeps it when a buyer link exists', async () => {
	const { state } = createFixture({ warm: true });
	const bar = () => document.querySelector('[data-buyer-link-bar]');
	await settle();
	expect(bar()).not.toBeNull();

	state.editor.persistence!.workBlock = 'deal-unavailable';
	await settle();
	expect(bar()).toBeNull();

	state.editor.buyerLink = {
		id: 'link-a' as Id<'buyerLinks'>,
		token: 'Ab3Cd4Ef5Gh6I',
		createdAt: 1,
		contentRevision: 0,
		concessions: {}
	};
	await settle();
	expect(bar()).not.toBeNull();

	state.editor.persistence!.deleted = true;
	await settle();
	expect(bar()).toBeNull();
});
