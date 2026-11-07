import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Harness from './AuthoringSnappinessHarness.svelte';
import { AdminAuthoringSession } from '../../src/lib/playbook/admin-authoring-session.svelte';
import { csmState } from './csm-state.svelte';
import {
	companyId,
	controlledClient,
	documentFixture,
	membershipId,
	settle
} from './snappiness-fixtures';

const context = vi.hoisted(() => ({
	baseline: {} as { data?: unknown },
	client: undefined as unknown
}));
vi.mock('convex-svelte', () => ({
	useQuery: () => context.baseline,
	useConvexClient: () => context.client
}));
vi.mock(
	'$lib/components/document/ContractViewer.svelte',
	() => import('./AuthoringSnappinessViewer.svelte')
);
vi.mock('$lib/components/workspace/WorkspaceChrome.svelte', () => import('./CsmChrome.svelte'));
let component: ReturnType<typeof mount> | undefined, session: AdminAuthoringSession;
beforeEach(() => {
	vi.stubGlobal('matchMedia', () => ({
		matches: true,
		addEventListener() {},
		removeEventListener() {}
	}));
});
afterEach(async () => {
	if (component) await unmount(component);
	session?.destroy();
	document.body.innerHTML = '';
});
function button(text: string) {
	return [...document.querySelectorAll<HTMLButtonElement>('button')].find(
		(b) => b.textContent?.trim() === text
	)!;
}
async function fixture() {
	const data = documentFixture(),
		network = controlledClient();
	context.client = network.client;
	context.baseline = {
		data: { blocks: data.blocks, baselineFingerprint: data.structure.baselineFingerprint }
	};
	session = new AdminAuthoringSession({
		client: network.client,
		membershipId,
		companyId,
		registerEditor: () => () => {}
	});
	session.start();
	component = mount(Harness, {
		target: document.body,
		props: { state: csmState(), authoring: session }
	});
	await settle();
	network.publish('playbookItems:currentStructure', data.structure);
	await settle();
	return { data, network };
}

it('shows the anchored cold panel on the next update without loading copy, and stays closed after cancellation', async () => {
	const f = await fixture();
	const main = document.querySelector('main[aria-label="Contract authoring"]');
	button('Open item-0').click();
	flushSync();
	expect(
		document.querySelector('[aria-label="Instruction box editor"] [aria-busy="true"]')
	).not.toBeNull();
	expect(document.querySelector('main[aria-label="Contract authoring"]')).toBe(main);
	expect(document.body.textContent).not.toMatch(/loading (?:these )?instructions/i);
	expect(session.controller.entry).toBeNull();
	button('Close').click();
	await settle();
	f.network.publishDetail(f.data.records[0]._id, f.data.detail(0));
	await settle();
	expect(document.querySelector('[aria-label="Instruction box editor"]')).toBeNull();
	expect(session.controller.entry).toBeNull();
});

it('opens a warm panel without a busy intermediate state and closes Save with pending annotation before acknowledgement', async () => {
	const f = await fixture();
	f.network.publishDetail(f.data.records[0]._id, f.data.detail(0));
	await settle();
	button('Open item-0').click();
	flushSync();
	expect(document.querySelector('[aria-busy="true"]')).toBeNull();
	const textarea = document.querySelector<HTMLTextAreaElement>(
		'[aria-label="Summary for this clause"]'
	)!;
	expect(textarea.value).toBe('Summary 0');
	textarea.value = 'Updated guidance';
	textarea.dispatchEvent(new Event('input', { bubbles: true }));
	await settle();
	button('Save').click();
	await settle();
	expect(f.network.mutation).toHaveBeenCalledTimes(1);
	expect(session.phase).toBe('saving');
	expect(document.querySelector('[aria-label="Instruction box editor"]')).toBeNull();
	expect(document.querySelector('[aria-label="Pending annotation"]')?.textContent).toBe('pending');
	// The controlled transport never acknowledged the save.
});
