import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../src/convex/_generated/dataModel';
import type { BuyerChangeReview } from '../../../src/lib/buyer/reviews.svelte';
import { BuyerContract } from '../../../src/lib/buyer/contract.svelte';
import {
	DiscussionWork,
	DiscussionRecovery,
	type ReplyComposerState
} from '../../../src/lib/discussions/recovery.svelte';
import {
	DiscussionSession,
	type DiscussionThread
} from '../../../src/lib/discussions/session.svelte';
import DiscussionRootCard from '../../../src/lib/discussions/DiscussionRootCard.svelte';
import { reactive } from '../../support/observers.svelte';
import { settle } from '../../support/svelte';
import { controlledClient } from '../../support/transport';
import BuyerChangeActionsHarness from './BuyerChangeActionsHarness.svelte';
import BuyerContractFailureHarness from './BuyerContractFailureHarness.svelte';

const thread: DiscussionThread = {
	id: 'thread' as Id<'discussionThreads'>,
	contentIdentity: 'published:1',
	contentRevision: 1,
	anchor: {
		start: { kind: 'source', point: { sourceKey: 'clause', offset: 0 } },
		end: { kind: 'source', point: { sourceKey: 'clause', offset: 6 } },
		quote: 'Clause'
	},
	type: 'proposal',
	root: {
		id: 'message' as Id<'discussionMessages'>,
		text: 'Suggested change',
		revision: 1,
		deleted: false,
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
			{ token: 'Ab3Cd4Ef5Gh6I' },
			() => 1,
			() => thread.contentIdentity
		);
		try {
			component = mount(DiscussionRootCard, {
				target: document.body,
				props: { thread, session, canRead: false, onActivate: () => {} }
			});
			await settle();
			expect(document.body.textContent).toContain('Suggested change');
			expect(session.work.replies.size).toBe(0);
			expect(session.work.edits.size).toBe(0);
		} finally {
			session.destroy();
		}
	});

	it('does not restore unsubmitted composer text after a session replacement', () => {
		const token = crypto.randomUUID();
		const first = new DiscussionRecovery(token);
		const stored = first.claim('buyer', false, new DiscussionWork());
		const composer = (id: string, text: string): ReplyComposerState => ({
			id,
			kind: 'reply',
			threadId: thread.id,
			authorKey: 'buyer',
			account: false,
			text,
			open: false,
			busy: false,
			error: null
		});
		stored.replies.set(thread.id, composer('stored', 'Typed before replacement'));
		first.persist('buyer', false, stored);

		const replacement = new DiscussionRecovery(token);
		const live = new DiscussionWork();
		live.replies.set(thread.id, composer('live', 'Typed in the replacement session'));
		const merged = replacement.claim('buyer', false, live);
		expect(merged.replies.get(thread.id)?.text).toBe('Typed in the replacement session');
		replacement.persist('buyer', false, merged);

		const restored = new DiscussionRecovery(token).claim('buyer', false, new DiscussionWork());
		expect(restored.replies.size).toBe(0);
	});

	it('releases geometry listeners when the document layout disappears', async () => {
		const root = document.createElement('div');
		const layout = document.createElement('div');
		document.body.append(root, layout);
		const state = reactive({
			root: root as HTMLElement | null,
			layout: layout as HTMLElement | null,
			ready: true
		});
		const session = {
			threads: [thread],
			feed: { authorized: true }
		} as unknown as DiscussionSession;
		const review = {
			watchProposal: vi.fn(() => () => {})
		} as unknown as BuyerChangeReview;
		component = mount(BuyerChangeActionsHarness, {
			target: document.body,
			props: { state, session, review }
		});
		await settle();
		expect(document.querySelector('[aria-label="Buyer change actions"]')).not.toBeNull();
		state.layout = null;
		await settle();
		window.dispatchEvent(new Event('resize'));
		state.root = null;
		await settle();
	});

	it('shows a retryable error when the contract renderer throws', async () => {
		const transport = controlledClient();
		const contract = new BuyerContract('Ab3Cd4Ef5Gh6I', transport.client);
		contract.help.configure({ kind: 'manual' });
		contract.help.considerAutomatic();
		contract.headerPresented = true;
		contract.allowed = true;
		contract.content = {
			contentIdentity: 'document' as Id<'contractDocuments'>,
			displayIdentity: 'published:1',
			title: 'Contract',
			contentRevision: 1,
			document: { blocks: [], pieceGroups: [], aliasGroups: [], removedBlockGroups: [] },
			annotationGroups: [],
			explanations: []
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
