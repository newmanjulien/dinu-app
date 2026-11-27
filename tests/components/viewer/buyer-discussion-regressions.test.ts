import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../src/convex/_generated/dataModel';
import { BuyerContract } from '../../../src/lib/buyer/contract.svelte';
import {
	DiscussionSession,
	type DiscussionThread
} from '../../../src/lib/discussions/session.svelte';
import DiscussionRootCard from '../../../src/lib/discussions/DiscussionRootCard.svelte';
import { settle } from '../../support/svelte';
import { controlledClient } from '../../support/transport';
import BuyerContractFailureHarness from './BuyerContractFailureHarness.svelte';

const thread: DiscussionThread = {
	id: 'thread' as Id<'discussionThreads'>,
	replies: [],
	contentRevision: 1,
	anchor: {
		start: { kind: 'source', point: { sourceKey: 'clause', offset: 0 } },
		end: { kind: 'source', point: { sourceKey: 'clause', offset: 6 } },
		quote: 'Clause'
	},
	root: {
		id: 'message' as Id<'discussionMessages'>,
		text: 'Question about clause',
		revision: 1,
		createdAt: 1,
		operationId: null,
		author: { key: 'buyer', name: 'Buyer', avatarUrl: null, buyer: true }
	}
};

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
	if (component) await unmount(component);
	component = undefined;
	document.body.replaceChildren();
});

describe('buyer discussion regressions', () => {
	it('renders a thread without creating reply or edit composers during render', async () => {
		const transport = controlledClient();
		const session = new DiscussionSession(
			transport.client as unknown as ConstructorParameters<typeof DiscussionSession>[0],
			{ kind: 'buyer', token: 'Ab3Cd4Ef5Gh6I' },
			() => 1
		);
		try {
			component = mount(DiscussionRootCard, {
				target: document.body,
				props: { thread, session, canRead: false, onActivate: () => {} }
			});
			await settle();
			expect(document.body.textContent).toContain('Question about clause');
			expect(session.replyComposer(thread.id)).toBeUndefined();
			expect(session.editComposer(thread.root.id)).toBeUndefined();
		} finally {
			session.destroy();
		}
	});

	it('shows a retryable error when the contract renderer throws', async () => {
		const transport = controlledClient();
		const contract = new BuyerContract(
			'Ab3Cd4Ef5Gh6I',
			transport.client,
			'version' as Id<'templateVersions'>
		);
		contract.help.configure({ kind: 'manual', variant: 'buyer-link-buyer' });
		contract.help.considerAutomatic();
		contract.headerPresented = true;
		contract.allowed = true;
		contract.content = {
			templateVersionId: 'version' as Id<'templateVersions'>,
			kind: 'current',
			companyName: 'Ocean Company',
			buyerName: 'Ocean Buyer',
			buyerRefreshable: false,
			displayIdentity: 'published:1',
			title: 'Contract',
			contentRevision: 1,
			blocks: [],
			concessions: {},
			appliedOverlays: [],
			rawExplanations: []
		};
		contract.Host = (() => {
			throw new Error('Renderer failed');
		}) as BuyerContract['Host'];
		contract.mountReady = true;
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			component = mount(BuyerContractFailureHarness, {
				target: document.body,
				props: { contract }
			});
			await settle();
			expect(contract.error).toContain('We couldn’t display this contract.');
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(
				'We couldn’t display this contract.'
			);
			expect(document.querySelector('[role="alert"] button')?.textContent).toContain('Retry');
			expect(log).toHaveBeenCalledWith('Buyer contract failed', { stage: 'construction' });
		} finally {
			contract.destroy();
			log.mockRestore();
		}
	});
});
