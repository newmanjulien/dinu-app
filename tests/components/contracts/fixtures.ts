import { fixtureOperationId } from '../../support/operation';
import { getFunctionName, type FunctionReturnType } from 'convex/server';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { Id } from '../../../src/convex/_generated/dataModel';
import { api } from '../../../src/convex/_generated/api';
import { AccountLifecycle } from '../../../src/lib/auth/account-lifecycle.svelte';
import { BuyerLinkController } from '../../../src/lib/buyer/links.svelte';
import type { SessionEditor } from '../../../src/lib/auth/viewer-session.svelte';
import type { ContractConcession } from '../../../src/lib/contract/changes';
import type { ContractDraft } from '../../../src/lib/contract/draft-recovery.svelte';
import { discoverContractDrafts } from '../../../src/lib/contract/draft-recovery.svelte';
import { ContractEditors } from '../../../src/lib/contract/editors.svelte';
import type { LiveContractState } from '../../../src/lib/contract/saved';
import { WorkspaceFeedback } from '../../../src/lib/components/chrome/workspace-feedback.svelte';
import type { ContractSaveRequest } from '../../../src/lib/contract/persistence.svelte';
import type { TemplateContent } from '../../../src/lib/template/model';
import Harness from './RouteHarness.svelte';
import { page, screen, setNavigate } from '../../support/navigation.svelte';
import { rendering } from './rendering.svelte';
import { controlledClient, deferred } from '../../support/transport';

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
vi.mock('$lib/components/workspace/SavedDocumentFrame.svelte', () => import('./Viewer.svelte'));
vi.mock('$lib/components/ui/modal/CompanyNameDialog.svelte', () => import('./NameDialog.svelte'));
vi.mock('$lib/contract/snapshot-cache', () => ({
	getContractOpenings: () => ({ read: () => [] }),
	getContractSnapshotCache: () => context.cache
}));

const contract = (
	id = 'contract-a',
	stateRevision = 1,
	concessions: ContractConcession[] = [],
	operation: string | null = null,
	metadataRevision = stateRevision
): LiveContractState => ({
	_id: id as Id<'savedContracts'>,
	_creationTime: 1,
	companyId: 'company' as Id<'company'>,
	creatorId: 'profile' as Id<'profiles'>,
	templateVersionId: 'version' as Id<'templateVersions'>,
	stateRevision,
	metadataRevision,
	title: 'Buyer',
	savedAt: 1,
	concessions,
	review: { generation: 0 },
	lastOperationId: operation,
	workBlock: null
});

function concessionsAfter(
	selections: Readonly<Record<string, string>>,
	approval = false
): ContractConcession[] {
	return Object.entries(selections)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([itemId, optionId]) => ({
			itemId: itemId as Id<'playbookItems'>,
			optionId,
			status: approval ? 'pending' : 'approved'
		}));
}

const template = (approval = false): TemplateContent => ({
	blockCount: 0,
	itemCount: 1,
	blocks: [],
	items: [
		{
			audience: 'rep',
			_id: 'item-a' as Id<'playbookItems'>,
			_creationTime: 1,
			companyId: 'company' as Id<'company'>,
			contentRevision: 1,
			instructions: {},
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
			concessions: [
				{
					id: 'preferred',
					tier: 'preferred',
					description: 'Choice',
					changes: [
						{
							target: {
								kind: 'text',
								range: {
									start: { sourceKey: 'text', offset: 0 },
									end: { sourceKey: 'text', offset: 1 }
								}
							},
							replacement: [{ kind: 'text', text: 'Updated' }]
						}
					]
				}
			]
		}
	]
});

function draft(id = 'contract-a'): ContractDraft {
	const base = contract(id);
	const selections = { ['item-a' as Id<'playbookItems'>]: 'preferred' };
	return {
		version: 1,
		baseStateRevision: base.stateRevision,
		selections,
		conflict: false,
		request: {
			id: id as Id<'savedContracts'>,
			operationId: fixtureOperationId('original-operation'),
			selections: { ...selections },
			expectedStateRevision: base.stateRevision
		}
	};
}

type Options = ConstructorParameters<typeof ContractEditors>[0];
const owners: { destroy(): void }[] = [];
const controllers: AccountLifecycle[] = [];
const mounted: ReturnType<typeof mount>[] = [];

async function settle() {
	flushSync();
	await Promise.all([
		import('../../../src/lib/components/workspace/ContractCreation.svelte'),
		import('../../../src/lib/components/workspace/SavedContract.svelte')
	]);
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
	const states = new Map<string, LiveContractState | null>();
	const writes: { request: ContractSaveRequest; result: ReturnType<typeof deferred<any>> }[] = [];
	let aggregate!: SessionEditor;
	let initialRead = read;
	let failures = 0;
	let removal = deferred<null>();
	const liveState = (id: string) => {
		const value = states.has(id) ? states.get(id) : contract(id);
		return value ? { ...value, buyerName: null, requestDelivery: null } : null;
	};
	const network = controlledClient((observation) => {
		queueMicrotask(() => {
			if (observation.released) return;
			const id = observation.args.id!;
			switch (observation.name) {
				case 'templateSources:authoringSource':
					observation.update({
						blocks: template(approval).blocks,
						templateSourceFingerprint: 'templateSource'
					});
					break;
				case 'contracts:state':
					if (!initialRead) break;
					if (failures > 0) {
						failures--;
						observation.error(new Error('Read failed'));
					} else observation.update(liveState(id));
			}
		});
	});
	const client = {
		onUpdate: network.onUpdate,
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
		peek: vi.fn(() => undefined),
		restore: vi.fn(async () => undefined),
		restoreMetadata: vi.fn(async () => undefined),
		invalidate: vi.fn(),
		loadFrozenVersion: vi.fn(async () => template(approval)),
		seedConfirmed: vi.fn((data) => data),
		updateState: vi.fn(),
		confirmMetadata: vi.fn(),
		remove: vi.fn(),
		isDeleted: () => false
	};
	const feedback: WorkspaceFeedback = new WorkspaceFeedback(() => owner.notices);
	const onSaved = vi.fn();
	const owner: ContractEditors = new ContractEditors({
		userId: 'user',
		membershipId: 'membership' as Id<'memberships'>,
		companyId: 'company' as Id<'company'>,
		client: client as unknown as Options['client'],
		cache,
		onSaved,
		onDeleted: () => {},
		onRenamed: () => {},
		registerEditor: (editor) => {
			aggregate = editor;
			if (controller) return controller.registerEditor(editor);
			editor.resume();
			return () => {};
		}
	});
	owners.push(feedback, owner);
	owner.configure(true, false, 0);
	if (start) owner.start();
	return {
		owner,
		feedback,
		onSaved,
		cache,
		client,
		writes,
		get aggregate() {
			return aggregate;
		},
		get removal() {
			return removal;
		},
		current: () => states.get('contract-a') ?? contract(),
		setRead(value: boolean) {
			initialRead = value;
		},
		failNext() {
			failures++;
		},
		publish(id: string, state: LiveContractState | null) {
			states.set(id, state);
			for (const observation of network.live('contracts:state'))
				if (observation.args.id === id) observation.update(liveState(id));
		},
		setState(id: string, state: LiveContractState | null) {
			states.set(id, state);
		},
		active(id?: string) {
			return network.live('contracts:state').filter((o) => id === undefined || o.args.id === id)
				.length;
		},
		ack(index = 0) {
			const write = writes[index];
			const state = contract(
				write.request.id,
				(states.get(write.request.id)?.stateRevision ?? 1) + 1,
				concessionsAfter(write.request.selections, approval),
				write.request.operationId
			);
			states.set(write.request.id, state);
			write.result.resolve({ status: 'saved', state });
			return state;
		}
	};
}

function show(f: ReturnType<typeof fixture>) {
	context.client = f.client;
	context.cache = f.cache;
	const target = document.createElement('div');
	document.body.append(target);
	const component = mount(Harness, { target, props: { sessions: f.owner } });
	mounted.push(component);
	return target;
}

function buyerLinkFixture(owner: ContractEditors, current = () => contract()) {
	type Client = ConstructorParameters<typeof BuyerLinkController>[0];
	const latest: FunctionReturnType<typeof api.buyerLinks.ensureLatest> = {
		id: 'link' as Id<'buyerLinks'>,
		token: 'Ab3Cd4Ef5Gh6I',
		createdAt: 0,
		created: true
	};
	const query = vi.fn<Client['query']>().mockImplementation(async (ref) => {
		if (getFunctionName(ref) === 'buyerLinks:latest') return null;
		expect(getFunctionName(ref)).toBe('contracts:state');
		const state = current();
		return {
			...state,
			buyerName: null,
			requestDelivery: null
		} as FunctionReturnType<typeof ref>;
	});
	const action = vi.fn<Client['action']>().mockResolvedValue(latest);
	const writeText = vi.fn().mockResolvedValue(undefined);
	const onCopied = vi.fn();
	vi.stubGlobal('navigator', { clipboard: { writeText } });
	const links = new BuyerLinkController(
		{
			query,
			action,
			connectionState: () => ({
				isWebSocketConnected: true,
				hasInflightRequests: false,
				timeOfOldestInflightRequest: null,
				hasEverConnected: true,
				connectionCount: 1,
				connectionRetries: 0,
				inflightMutations: 0,
				inflightActions: 0
			})
		},
		owner,
		'membership' as Id<'memberships'>,
		'contract-a' as Id<'savedContracts'>,
		onCopied
	);
	owners.push(links);
	return { links, latest, query, action, writeText, onCopied };
}

beforeEach(() => {
	HTMLDialogElement.prototype.showModal = function () {
		this.open = true;
	};
	HTMLDialogElement.prototype.close = function () {
		this.open = false;
	};
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
		if (path === '/contracts') screen.home = true;
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

export {
	contract,
	concessionsAfter,
	template,
	draft,
	controllers,
	settle,
	fixture,
	show,
	buyerLinkFixture
};
