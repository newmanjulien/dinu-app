import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Harness from './AuthoringSnappinessHarness.svelte';
import { TemplateAuthoringSession } from '../../../src/lib/playbook/template-authoring-session.svelte';
import { TemplateSource } from '../../../src/lib/playbook/template-source.svelte';
import { csmState } from '../../support/csm-state.svelte';
import { companyId, documentFixture, membershipId } from '../../support/document';
import { controlledClient } from '../../support/transport';
import { settle } from '../../support/svelte';

vi.mock(
	'$lib/components/document/DocumentViewer.svelte',
	() => import('./AuthoringSnappinessViewer.svelte')
);
vi.mock(
	'$lib/components/workspace/WorkspaceChrome.svelte',
	() => import('../../support/CsmChrome.svelte')
);
let component: ReturnType<typeof mount> | undefined, session: TemplateAuthoringSession;
let templateSource: TemplateSource | undefined;
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
	templateSource?.destroy();
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
	const sourcePayload = {
		blocks: data.blocks,
		templateSourceFingerprint: data.structure.templateSourceFingerprint
	};
	templateSource = new TemplateSource(network.client, membershipId);
	session = new TemplateAuthoringSession({
		templateSource,
		client: network.client,
		membershipId,
		companyId,
		audience: 'rep',
		registerEditor: () => () => {}
	});
	session.start();
	component = mount(Harness, {
		target: document.body,
		props: { state: csmState(), authoring: session }
	});
	await settle();
	network.publish('templateSources:authoringSource', sourcePayload);
	network.publish('playbookItems:currentStructure', data.structure);
	await settle();
	return { data, network };
}

it('shows the anchored cold panel on the next update without loading copy, and stays closed after cancellation', async () => {
	const f = await fixture();
	const main = document.querySelector('main[aria-label="Template editor"]');
	button('Open item-0').click();
	flushSync();
	expect(
		document.querySelector('[aria-label="Instructions editor"] [aria-busy="true"]')
	).not.toBeNull();
	expect(document.querySelector('main[aria-label="Template editor"]')).toBe(main);
	expect(document.body.textContent).not.toMatch(/loading (?:these )?instructions/i);
	expect(session.controller.entry).toBeNull();
	button('Close').click();
	await settle();
	f.network.publishDetail(f.data.records[0]._id, f.data.detail(0));
	await settle();
	expect(document.querySelector('[aria-label="Instructions editor"]')).toBeNull();
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
	expect(document.querySelector('[aria-label="Instructions editor"]')).toBeNull();
	expect(document.querySelector('[aria-label="Pending annotation"]')?.textContent).toBe('pending');
	// The controlled transport never acknowledged the save.
});
