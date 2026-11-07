import { getFunctionName } from 'convex/server';
import type { Snippet } from 'svelte';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../src/convex/_generated/dataModel';
import { AccountLifecycle } from '../../src/lib/auth/account-lifecycle.svelte';
import type { SessionEditor } from '../../src/lib/auth/viewer-session.svelte';
import { type ApplicationChoices } from '../../src/lib/contract/applications';
import type { ContractDraft } from '../../src/lib/contract/draft-recovery.svelte';
import { DraftJournal, discoverContractDrafts } from '../../src/lib/contract/draft-recovery.svelte';
import { ContractEditors } from '../../src/lib/contract/editors.svelte';
import { WorkspaceFeedback } from '../../src/lib/components/chrome/workspace-feedback.svelte';
import type { ContractSaveRequest } from '../../src/lib/contract/persistence.svelte';
import type { TemplateContent } from '../../src/lib/contract/saved';
import type { ContractLayoutProfiles } from '../../src/lib/document/runtime/layout-context.svelte';
import { DocumentResources } from '../../src/lib/document/runtime/resources.svelte';
import type { ContractWorkspace } from '../../src/lib/document/runtime/workspace-context';
import Harness from './RouteHarness.svelte';
import { page, screen, setNavigate } from './navigation.svelte';
import { rendering } from './rendering.svelte';

const context = vi.hoisted(() => ({ client: undefined as unknown, cache: undefined as unknown }));
vi.mock('convex-svelte', () => ({
	useConvexClient: () => context.client,
	useAuth: () => ({ isAuthenticated: true }),
	useQuery: (ref: Parameters<typeof getFunctionName>[0]) => ({
		data:
			getFunctionName(ref) === 'hubspotConnections:status'
				? {
						status: 'uninstalled',
						enabled: false,
						accountId: null,
						installedAt: null,
						configured: false
					}
				: { versionId: 'version' }
	})
}));
vi.mock('$lib/auth/DocumentBody.svelte', () => import('./DocumentBody.svelte'));
vi.mock('$lib/components/workspace/RepWorkspace.svelte', () => import('./Viewer.svelte'));
vi.mock('$lib/components/workspace/ContractPreview.svelte', () => import('./DocumentBody.svelte'));
vi.mock('$lib/components/ui/modal/CompanyNameDialog.svelte', () => import('./NameDialog.svelte'));
vi.mock('$lib/contract/snapshot-cache', () => ({
	getContractOpenings: () => ({ read: () => [] }),
	getContractSnapshotCache: () => context.cache
}));

function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const contract = (
	id = 'contract-a',
	editRevision = 1,
	choices: Record<string, string> | ApplicationChoices = {},
	operation: string | null = null
) => ({
	_id: id as Id<'savedContracts'>,
	_creationTime: 1,
	companyId: 'company' as Id<'company'>,
	creatorId: 'profile' as Id<'profiles'>,
	templateVersionId: 'version' as Id<'templateVersions'>,
	buyerCompanyName: 'Buyer',
	savedAt: 1,
	editRevision,
	reviewGeneration: editRevision,
	stateVersion: editRevision,
	reviewCompletion: null,
	applications: Object.fromEntries(
		Object.entries(choices).map(([id, value]) => [
			id,
			typeof value === 'string'
				? { concessionId: value }
				: {
						concessionId: value.concessionId,
						...(value.applicationId
							? { approval: { applicationId: value.applicationId, status: 'pending' as const } }
							: {})
					}
		])
	),
	lastOperationId: operation
});
const template = (approval = false): TemplateContent => ({
	blockCount: 0,
	itemCount: 1,
	blocks: [],
	items: [
		{
			_id: 'item-a' as Id<'playbookItems'>,
			_creationTime: 1,
			companyId: 'company' as Id<'company'>,
			contentRevision: 1,
			approvalPolicy: approval
				? { kind: 'required', instructions: 'Approval required' }
				: { kind: 'none' },
			trigger: {
				id: 'trigger',
				target: {
					kind: 'text',
					range: {
						start: { sourceKey: 'text', offset: 0 },
						end: { sourceKey: 'text', offset: 1 }
					}
				}
			},
			concessions: [{ id: 'preferred', tier: 'preferred', description: 'Choice', changes: [] }]
		}
	]
});
function draft(id = 'contract-a'): ContractDraft {
	return {
		version: 4,
		base: contract(id),
		intent: { ['item-a' as Id<'playbookItems'>]: { concessionId: 'preferred' } },
		conflict: false,
		request: {
			id: id as Id<'savedContracts'>,
			expectedEditRevision: 1,
			operationId: 'original-operation',
			choices: { ['item-a' as Id<'playbookItems'>]: { concessionId: 'preferred' } }
		}
	};
}
type Options = ConstructorParameters<typeof ContractEditors>[0];
const owners: { destroy(): void }[] = [];
const controllers: AccountLifecycle[] = [];
const mounted: ReturnType<typeof mount>[] = [];
async function settle() {
	flushSync();
	await vi.dynamicImportSettled();
	for (let i = 0; i < 6; i++) {
		await Promise.resolve();
		flushSync();
		await tick();
	}
}
function fixture({
	approval = false,
	read = true,
	start = true,
	controller
}: {
	approval?: boolean;
	read?: boolean;
	start?: boolean;
	controller?: AccountLifecycle;
} = {}) {
	const subscriptions = new Map<
		string,
		Set<{
			data: (value: ReturnType<typeof contract> | null) => void;
			error: (error: Error) => void;
		}>
	>();
	const states = new Map<string, ReturnType<typeof contract> | null>();
	const writes: { request: ContractSaveRequest; result: ReturnType<typeof deferred<any>> }[] = [];
	let aggregate!: SessionEditor;
	let initialRead = read;
	let failures = 0;
	let removal = deferred<null>();
	const client = {
		onUpdate: vi.fn((_ref, args, data, error) => {
			const entry = { data, error };
			let listeners = subscriptions.get(args.id);
			if (!listeners) subscriptions.set(args.id, (listeners = new Set()));
			listeners.add(entry);
			queueMicrotask(() => {
				if (initialRead && listeners.has(entry)) {
					if (failures > 0) {
						failures--;
						error(new Error('Read failed'));
					} else data(states.has(args.id) ? states.get(args.id) : contract(args.id));
				}
			});
			return () => listeners.delete(entry);
		}),
		mutation: vi.fn((ref, args) => {
			const name = getFunctionName(ref);
			if (name === 'contracts:remove') return removal.promise;
			if (name === 'contracts:rename') return Promise.resolve(null);
			if (name === 'contracts:create')
				return Promise.resolve({
					status: 'created',
					id: 'contract-b',
					contract: contract('contract-b')
				});
			const result = deferred<any>();
			writes.push({ request: args, result });
			return result.promise;
		})
	};
	const cache = {
		loadVersion: vi.fn(async () => template(approval)),
		seedConfirmed: vi.fn((data) => data),
		updateState: vi.fn(),
		confirmMetadata: vi.fn(),
		remove: vi.fn(),
		isDeleted: () => false
	};
	const feedback: WorkspaceFeedback = new WorkspaceFeedback(() => owner.notices);
	const owner: ContractEditors = new ContractEditors({
		userId: 'user',
		membershipId: 'membership' as Id<'memberships'>,
		companyId: 'company' as Id<'company'>,
		client: client as unknown as Options['client'],
		cache,
		onSaved: feedback.contractSaved,
		onDeleted: feedback.contractDeleted,
		onRenamed: feedback.contractRenamed,
		registerEditor: (editor) => {
			aggregate = editor;
			if (controller) return controller.registerEditor(editor);
			editor.resume();
			return () => {};
		}
	});
	owners.push(feedback, owner);
	context.client = client;
	context.cache = cache;
	owner.configure(true, false, 0);
	if (start) owner.start();
	return {
		owner,
		feedback,
		cache,
		client,
		writes,
		get aggregate() {
			return aggregate;
		},
		get removal() {
			return removal;
		},
		setRead(value: boolean) {
			initialRead = value;
		},
		failNext() {
			failures++;
		},
		publish(id: string, state: ReturnType<typeof contract> | null) {
			states.set(id, state);
			for (const listener of subscriptions.get(id) ?? []) listener.data(state);
		},
		setState(id: string, state: ReturnType<typeof contract> | null) {
			states.set(id, state);
		},
		active(id?: string) {
			return id
				? (subscriptions.get(id)?.size ?? 0)
				: [...subscriptions.values()].reduce((n, listeners) => n + listeners.size, 0);
		},
		ack(index = 0) {
			const write = writes[index];
			const state = contract(
				write.request.id,
				write.request.expectedEditRevision + 1,
				write.request.choices,
				write.request.operationId
			);
			write.result.resolve({ status: 'saved', state });
			return state;
		}
	};
}
function show(owner: ContractEditors) {
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(Harness, { target, props: { sessions: owner } });
	mounted.push(component);
	return target;
}
beforeEach(() => {
	rendering.ready = true;
	sessionStorage.clear();
	screen.home = false;
	screen.destination = { kind: 'saved', id: 'contract-a' };
	page.data = { contractRoute: { id: 'contract-a' } };
	page.url = new URL('https://test.local/contracts/contract-a');
	setNavigate(async (path) => {
		page.url = new URL(path, page.url);
		page.data = {};
		await tick();
		if (path === '/') screen.home = true;
		else {
			screen.home = false;
			screen.destination = { kind: 'saved', id: path.split('/').pop()! };
		}
		await tick();
	});
});
afterEach(async () => {
	for (const component of mounted.splice(0)) await unmount(component);
	for (const controller of controllers.splice(0)) controller.destroy();
	for (const owner of owners.splice(0)) owner.destroy();
	for (const { journal } of discoverContractDrafts('user', 'membership')) journal.write(null);
	document.body.innerHTML = '';
	vi.useRealTimers();
});

describe('route and editing lifetimes', () => {
	it('commits Home while saving and reattaches one owner with local choices', async () => {
		const f = fixture();
		const target = show(f.owner);
		await settle();
		(target.querySelectorAll('button')[1] as HTMLButtonElement).click();
		await settle();
		const original = f.owner.entries[0];
		expect(f.writes).toHaveLength(1);
		(target.querySelector('button') as HTMLButtonElement).click();
		await settle();
		expect(target.textContent).toContain('Home content');
		expect(original.pending).toBe(true);
		expect(f.active('contract-a')).toBe(1);
		screen.home = false;
		await settle();
		expect(f.owner.entries[0]).toBe(original);
		expect(target.textContent).toContain('preferred');
		expect(f.active('contract-a')).toBe(1);
		expect(f.writes).toHaveLength(1);
		f.ack();
		await settle();
		screen.home = true;
		await settle();
		expect(f.owner.entries).toHaveLength(0);
		expect(f.active()).toBe(0);
		expect(f.feedback.statusFor('contract-a')).toBe('Saved');
	});
	it('waits for the write response when metadata acknowledges first', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.select('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		a.release();
		const request = f.writes[0].request;
		f.publish('contract-a', contract('contract-a', 2, request.choices, request.operationId));
		await settle();
		expect(a.editor.inFlight).toBe(true);
		expect(f.owner.entries).toHaveLength(1);
		expect(f.writes).toHaveLength(1);
		let completed = false;
		const flushed = f.aggregate.prepareToLeave().then((ok) => {
			completed = true;
			return ok;
		});
		await settle();
		expect(completed).toBe(false);
		f.ack();
		await settle();
		expect(await flushed).toBe(true);
		expect(f.owner.entries).toHaveLength(0);
		expect(f.active()).toBe(0);
	});
	it('flushes a detached contract before clean disposal', async () => {
		const f = fixture();
		const acquired = f.owner.acquire('contract-a');
		await settle();
		acquired.editor.persistence!.select('item-a' as Id<'playbookItems'>, 'preferred');
		acquired.release();
		await settle();
		const flushed = f.aggregate.prepareToLeave();
		f.ack();
		await settle();
		expect(await flushed).toBe(true);
		expect(f.owner.entries).toHaveLength(0);
	});
	it('saves contracts independently without a host or rendering resources', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a'),
			b = f.owner.acquire('contract-b');
		await settle();
		for (const acquired of [a, b]) {
			acquired.editor.persistence!.select('item-a' as Id<'playbookItems'>, 'preferred');
			acquired.release();
		}
		await settle();
		expect(f.writes).toHaveLength(2);
		f.ack(1);
		await settle();
		expect(f.owner.entries.map((entry) => entry.id)).toEqual(['contract-a']);
		f.ack(0);
		await settle();
		expect(f.owner.entries).toHaveLength(0);
	});
	it('keeps the created ID when opening fails and the creator retries', async () => {
		const f = fixture();
		f.failNext();
		screen.destination = { kind: 'new' };
		const target = show(f.owner);
		await settle();
		(target.querySelectorAll('button')[1] as HTMLButtonElement).click();
		await settle();
		expect(target.textContent).toContain('Your contract was created, but we couldn’t open it');
		const open = [...target.querySelectorAll('button')].find(
			(button) => button.textContent === 'Open contract'
		)!;
		open.click();
		await settle();
		expect(target.querySelector('[aria-label="Contract viewer"]')).not.toBeNull();
		expect(
			f.client.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'contracts:create')
		).toHaveLength(1);
		expect(screen.destination).toEqual({ kind: 'saved', id: 'contract-b' });
	});
	it('offers creation Retry when rendering stalls without creating another contract', async () => {
		vi.useFakeTimers();
		rendering.ready = false;
		const f = fixture();
		screen.destination = { kind: 'new' };
		const target = show(f.owner);
		await settle();
		(target.querySelectorAll('button')[1] as HTMLButtonElement).click();
		await settle();
		expect(f.active('contract-b')).toBe(1);
		await vi.advanceTimersByTimeAsync(15_001);
		await settle();
		expect(target.textContent).toContain('Your contract was created, but we couldn’t open it');
		rendering.ready = true;
		[...target.querySelectorAll('button')]
			.find((button) => button.textContent === 'Open contract')!
			.click();
		await settle();
		expect(target.textContent).not.toContain('Your contract was created, but we couldn’t open it');
		expect(
			f.client.mutation.mock.calls.filter(([ref]) => getFunctionName(ref) === 'contracts:create')
		).toHaveLength(1);
		expect(screen.destination).toEqual({ kind: 'saved', id: 'contract-b' });
		expect(f.owner.entries[0].attachments).toBe(1);
		expect(f.active('contract-b')).toBe(1);
	});
	it('disposes a detached opening failure when it has no unsaved intent', async () => {
		const f = fixture();
		f.failNext();
		const acquired = f.owner.acquire('contract-a');
		await settle();
		expect(acquired.editor.error).not.toBeNull();
		expect(f.feedback.notices).toHaveLength(0);
		acquired.release();
		await settle();
		expect(f.owner.entries).toHaveLength(0);
		expect(f.active()).toBe(0);
	});
});

describe('recovery and account exits', () => {
	it('resumes account-exit saving after auth loading clears without a scope update', async () => {
		const signOut = vi.fn(async () => {});
		const controller = new AccountLifecycle({
			signOut,
			login: async () => {},
			clear() {},
			cancelReads() {}
		});
		controllers.push(controller);
		controller.identity('session', 'user', true);
		controller.reportAuth(false, true);
		controller.reportAccount(true);
		const f = fixture({ controller });
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.select('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		const original = f.writes[0].request;
		const exiting = controller.signOut();
		await settle();
		controller.reportAuth(true, true);
		await settle();
		await exiting;
		expect(f.owner.accessAvailable).toBe(false);
		expect(signOut).not.toHaveBeenCalled();
		expect(f.owner.pending).toBe(true);
		controller.reportAuth(false, true);
		await settle();
		expect(f.owner.accessAvailable).toBe(true);
		expect(f.client.onUpdate).toHaveBeenCalledTimes(2);
		expect(f.writes[1].request).toEqual(original);
		const retry = controller.signOut();
		await settle();
		f.ack(1);
		await settle();
		await retry;
		expect(signOut).toHaveBeenCalledOnce();
		expect(f.owner.pending).toBe(false);
		f.ack(0);
		await settle();
		expect(f.owner.pending).toBe(false);
	});
	it('does not let account readiness bypass a company hold', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		f.owner.configure(false, true, 0);
		f.aggregate.resume();
		await settle();
		expect(f.owner.accessAvailable).toBe(false);
		expect(f.active()).toBe(0);
		f.owner.configure(true, false, 0);
		await settle();
		expect(f.owner.accessAvailable).toBe(true);
		expect(f.active()).toBe(1);
		a.release();
	});
	it('replays the journal operation and approval applicationId unchanged', async () => {
		const recovery = draft();
		recovery.intent['item-a' as Id<'playbookItems'>].applicationId = 'original-application';
		recovery.request!.choices = structuredClone(recovery.intent);
		new DraftJournal('user', 'contract-a', 'membership').write(recovery);
		const f = fixture({ approval: true });
		expect(f.aggregate.pending).toBe(true);
		await settle();
		expect(f.writes[0].request.operationId).toBe('original-operation');
		expect(f.writes[0].request.choices['item-a' as Id<'playbookItems'>].applicationId).toBe(
			'original-application'
		);
		expect(f.owner.entries[0].snapshot).toBeUndefined();
	});
	it('cannot flush a queued or failed initialization as clean during logout', async () => {
		vi.useFakeTimers();
		new DraftJournal('user', 'contract-a', 'membership').write(draft());
		const f = fixture({ read: false });
		expect(f.aggregate.pending).toBe(true);
		const flushed = f.aggregate.prepareToLeave();
		await settle();
		await vi.advanceTimersByTimeAsync(15_001);
		await settle();
		expect(await flushed).toBe(false);
		expect(f.aggregate.pending).toBe(true);
		expect(f.feedback.statusFor('contract-a')).toBe('Save failed');
		expect(f.active()).toBe(0);
		expect(new DraftJournal('user', 'contract-a', 'membership').read()?.request?.operationId).toBe(
			'original-operation'
		);
		f.setRead(true);
		f.aggregate.retry();
		await settle();
		expect(f.writes).toHaveLength(1);
		f.ack();
		await settle();
		expect(await f.aggregate.prepareToLeave()).toBe(true);
	});
	it('bounds recovered initialization, with foreground work allowed immediately', async () => {
		for (let i = 0; i < 8; i++)
			new DraftJournal('user', `recovered-${i}`, 'membership').write(draft(`recovered-${i}`));
		const f = fixture();
		const reads: ReturnType<typeof deferred<TemplateContent>>[] = [];
		f.cache.loadVersion.mockImplementation(() => {
			const read = deferred<TemplateContent>();
			reads.push(read);
			return read.promise;
		});
		await settle();
		expect(f.owner.entries.filter((entry) => entry.initializing)).toHaveLength(2);
		expect(f.active()).toBe(2);
		const foreground = f.owner.acquire('foreground');
		await settle();
		expect(reads).toHaveLength(3);
		reads[0].resolve(template());
		await settle();
		expect(reads).toHaveLength(4);
		expect(
			f.owner.entries.filter((entry) => entry.id.startsWith('recovered-') && entry.initializing)
		).toHaveLength(2);
		foreground.release();
	});
	it('compacts failed work and retries it with the same immutable request', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.select('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		a.release();
		f.writes[0].result.reject(new Error('Offline'));
		await settle();
		expect(f.active()).toBe(0);
		expect(a.editor.snapshot).toBeUndefined();
		expect(f.feedback.statusFor('contract-a')).toBe('Save failed');
		f.owner.retry('contract-a');
		await settle();
		expect(f.writes).toHaveLength(2);
		expect(f.writes[1].request).toEqual(f.writes[0].request);
		f.ack(1);
		await settle();
		expect(f.owner.entries).toHaveLength(0);
	});
	it('reconciles replaced transport before replay, ignoring late callbacks', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.select('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		const request = f.writes[0].request;
		f.owner.configure(false, true, 1);
		a.release();
		await settle();
		expect(f.active()).toBe(0);
		expect(f.owner.pending).toBe(true);
		f.setState('contract-a', contract('contract-a', 2, request.choices, request.operationId));
		f.owner.configure(true, false, 1);
		await settle();
		expect(f.writes).toHaveLength(1);
		expect(f.owner.pending).toBe(false);
		f.ack(0);
		await settle();
		expect(f.owner.pending).toBe(false);
		expect(f.owner.entries).toHaveLength(0);
	});
	it('pauses company holds and flushes pending work with editing frozen', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		f.owner.configure(false, true, 0);
		await settle();
		// Previously checkpointed intent is discovered while the company is paused.
		new DraftJournal('user', 'contract-b', 'membership').write(draft('contract-b'));
		const b = f.owner.acquire('contract-b');
		expect(b.editor.pending).toBe(true);
		expect(f.writes).toHaveLength(0);
		f.owner.configure(true, true, 0);
		await settle();
		expect(b.editor.persistence!.editable).toBe(false);
		expect(f.writes).toHaveLength(1);
		const flushed = f.aggregate.prepareToLeave();
		f.ack();
		await settle();
		expect(await flushed).toBe(true);
		a.release();
		b.release();
	});
	it('keeps conflict intent and stops detached subscriptions', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.select('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		const remote = contract('contract-a', 2, {}, 'other-operation');
		f.publish('contract-a', remote);
		f.writes[0].result.resolve({ status: 'conflict', state: remote });
		a.release();
		await settle();
		expect(f.feedback.statusFor('contract-a')).toBe('Conflict');
		expect(f.active()).toBe(0);
		expect(a.editor.snapshot).toBeUndefined();
		const reopened = f.owner.acquire('contract-a');
		await settle();
		expect(reopened.editor.persistence!.choices).toEqual({
			['item-a' as Id<'playbookItems'>]: 'preferred'
		});
		reopened.editor.persistence!.applyRecovered();
		await settle();
		expect(f.writes[1].request.expectedEditRevision).toBe(2);
		expect(f.writes[1].request.operationId).not.toBe(f.writes[0].request.operationId);
	});
	it('explicit discard invalidates late responses and clears the journal', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.select('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		a.release();
		f.aggregate.discard();
		await settle();
		f.ack();
		await settle();
		expect(f.owner.entries).toHaveLength(0);
		expect(new DraftJournal('user', 'contract-a', 'membership').read()).toBeNull();
		expect(f.writes).toHaveLength(1);
		expect(f.feedback.statusFor('contract-a')).toBeUndefined();
	});
	it('coordinates confirmed deletion and retains intent after failed deletion', async () => {
		const f = fixture();
		const a = f.owner.acquire('contract-a');
		await settle();
		a.editor.persistence!.select('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		a.release();
		const removing = f.owner.remove('contract-a' as Id<'savedContracts'>);
		f.removal.resolve(null);
		await removing;
		await settle();
		expect(f.cache.remove).toHaveBeenCalledWith('contract-a');
		expect(new DraftJournal('user', 'contract-a', 'membership').read()).toBeNull();
		const g = fixture();
		const b = g.owner.acquire('contract-b');
		await settle();
		b.editor.persistence!.select('item-a' as Id<'playbookItems'>, 'preferred');
		await settle();
		b.release();
		const failed = g.owner.remove('contract-b' as Id<'savedContracts'>);
		const rejected = expect(failed).rejects.toThrow('Delete failed');
		g.removal.reject(new Error('Delete failed'));
		await rejected;
		await settle();
		expect(b.editor.pending).toBe(true);
		expect(new DraftJournal('user', 'contract-b', 'membership').read()).not.toBeNull();
		expect(g.writes.at(-1)!.request.operationId).toBe(g.writes[0].request.operationId);
	});
});

it('prevents old attachments from clearing a replacement view', () => {
	const profiles = {
		profiler: undefined,
		scheduler: { wake: vi.fn() }
	} as unknown as ContractLayoutProfiles;
	const workspace = {
		accept: vi.fn(),
		source: {},
		viewer: { ready: false, visible: false },
		renderer: { retainedPageCount: 0, destroy: vi.fn() }
	} as unknown as ContractWorkspace;
	const resources = new DocumentResources(profiles, () => () => workspace);
	const entry = resources.acquire('contract-a', { blocks: { data: [] }, items: { data: [] } });
	const old = resources.activate(entry, { 'item-a': 'old' });
	const current = resources.activate(entry, { 'item-a': 'new' });
	const target = document.createElement('div');
	const bindings = {
		panelContent: (() => {}) as unknown as Snippet,
		selectedConcessions: { 'item-a': 'new' },
		onRemoveConcession() {},
		onSelect() {}
	};
	current.bind(bindings, target);
	workspace.viewer.pagesVisible = true;
	old.update({ 'item-a': 'stale' });
	old.release();
	expect(entry.target).toBe(target);
	expect(entry.bindings).toBe(bindings);
	expect(entry.choices).toEqual({ 'item-a': 'new' });
	expect(workspace.viewer.pagesVisible).toBe(true);
	current.release();
	expect(entry.target).toBeUndefined();
	resources.destroy();
});
