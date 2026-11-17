import { fixtureOperationId } from '../../support/operation';
import { getFunctionName, type FunctionReturnType } from 'convex/server';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { Id } from '../../../src/convex/_generated/dataModel';
import { api } from '../../../src/convex/_generated/api';
import { AccountLifecycle } from '../../../src/lib/auth/account-lifecycle.svelte';
import { BuyerLinkController } from '../../../src/lib/buyer/links.svelte';
import type { SessionEditor } from '../../../src/lib/auth/viewer-session.svelte';
import type { PlaybookState, PlaybookCommand } from '../../../src/lib/contract/changes';
import type { ContractDraft } from '../../../src/lib/contract/draft-recovery.svelte';
import { discoverContractDrafts } from '../../../src/lib/contract/draft-recovery.svelte';
import { ContractEditors } from '../../../src/lib/contract/editors.svelte';
import { resolveTemplateItem } from '../../../src/lib/contract/items';
import { isRepItem } from '../../../src/lib/playbook/model';
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
vi.mock('$lib/auth/DocumentBody.svelte', () => import('../../support/DocumentBody.svelte'));
vi.mock('$lib/components/workspace/SavedDocumentFrame.svelte', () => import('./Viewer.svelte'));
vi.mock('$lib/components/ui/modal/CompanyNameDialog.svelte', () => import('./NameDialog.svelte'));
vi.mock('$lib/contract/snapshot-cache', () => ({
	getContractOpenings: () => ({ read: () => [] }),
	getContractSnapshotCache: () => context.cache
}));

const contract = (
	id = 'contract-a',
	stateRevision = 1,
	playbook: PlaybookState[] = [],
	operation: string | null = null
) => ({
	_id: id as Id<'savedContracts'>,
	_creationTime: 1,
	companyId: 'company' as Id<'company'>,
	creatorId: 'profile' as Id<'profiles'>,
	templateVersionId: 'version' as Id<'templateVersions'>,
	documentId: `${id}-document` as Id<'contractDocuments'>,
	documentRevision: 0,
	stateRevision,
	title: 'Buyer',
	savedAt: 1,
	playbook,
	reviews: {
		playbook: { identity: `playbook:${stateRevision}` },
		buyerLink: { identity: 'buyer-link:0' }
	},
	lastOperationId: operation
});
/** Native server acknowledgment fixture allocates heads; client commands carry no predicted IDs. */
function headsAfter(base: readonly PlaybookState[], commands: readonly PlaybookCommand[]) {
	const heads = new Map(base.map((head) => [head.itemId, head]));
	for (const command of commands) {
		const previous = heads.get(command.itemId),
			action = command.action;
		if (action.kind === 'withdraw') {
			if (previous)
				heads.set(command.itemId, {
					...previous,
					currentChangeId: previous.appliedChangeId,
					currentOptionId: previous.appliedOptionId
				});
		} else
			heads.set(command.itemId, {
				itemId: command.itemId,
				currentChangeId: `server:${command.id}` as Id<'contractChanges'>,
				appliedChangeId: `server:${command.id}` as Id<'contractChanges'>,
				currentOptionId: action.optionId,
				appliedOptionId: action.optionId,
				status: 'approved',
				decisionId: null
			});
	}
	return [...heads.values()];
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
	const commands: PlaybookCommand[] = [
		{
			id: fixtureOperationId('original-command'),
			itemId: 'item-a' as Id<'playbookItems'>,
			expectedCurrentChangeId: null,
			action: { kind: 'set', optionId: 'preferred' },
			occurredAt: 1
		}
	];
	return {
		version: 12,
		commands,
		base: contract(id),
		conflict: false,
		blocked: false,
		request: {
			id: id as Id<'savedContracts'>,
			operationId: fixtureOperationId('original-operation'),
			commands: structuredClone(commands)
		}
	};
}
type Options = ConstructorParameters<typeof ContractEditors>[0];
const owners: { destroy(): void }[] = [];
const controllers: AccountLifecycle[] = [];
const mounted: ReturnType<typeof mount>[] = [];
async function settle() {
	flushSync();
	// Route assertions need these modules; background code warming may continue independently.
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
	selectedRead = true,
	start = true,
	controller
}: {
	approval?: boolean;
	read?: boolean;
	selectedRead?: boolean;
	start?: boolean;
	controller?: AccountLifecycle;
} = {}) {
	const states = new Map<string, ReturnType<typeof contract> | null>();
	const selectedPayload = (
		id: string
	): FunctionReturnType<typeof api.contractDefinitions.current> => ({
		document: { blocks: [], pieceGroups: [], aliasGroups: [], removedBlockGroups: [] },
		documentId: (states.get(id) ?? contract(id)).documentId,
		documentRevision: (states.get(id) ?? contract(id)).documentRevision,
		displayIdentity: `${id}:approved:0`,
		hiddenItemIds: [],
		projectedTargets: template(approval)
			.items.filter(isRepItem)
			.map(resolveTemplateItem)
			.map((item) => ({
				itemId: item._id,
				trigger: item.primary.target,
				choices: item.choices.map((choice) => ({
					id: choice.id,
					targets: choice.changes.map((change) => change.target)
				}))
			}))
	});
	const approvedReads = new Map<
		string,
		ReturnType<typeof deferred<ReturnType<typeof selectedPayload>>>
	>();
	const writes: { request: ContractSaveRequest; result: ReturnType<typeof deferred<any>> }[] = [];
	let aggregate!: SessionEditor;
	let initialRead = read;
	let failures = 0;
	let removal = deferred<null>();
	const network = controlledClient((observation) => {
		queueMicrotask(() => {
			if (observation.released) return;
			const id = observation.args.id!;
			switch (observation.name) {
				case 'contractDefinitions:current':
					if (selectedRead) observation.update(selectedPayload(id));
					break;
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
					} else observation.update(states.has(id) ? states.get(id) : contract(id));
			}
		});
	});
	const publishSelected = (id?: string) => {
		for (const observation of network.live('contractDefinitions:current'))
			if (id === undefined || observation.args.id === id)
				observation.update(selectedPayload(observation.args.id!));
	};
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
		peekApproved: vi.fn(() => undefined),
		rememberApproved: vi.fn((_id, data) => data),
		loadApproved: vi.fn(async (id: string) => {
			if (selectedRead) return selectedPayload(id);
			let read = approvedReads.get(id);
			if (!read) {
				read = deferred<ReturnType<typeof selectedPayload>>();
				approvedReads.set(id, read);
			}
			return read.promise;
		}),
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
		publish(id: string, state: ReturnType<typeof contract> | null) {
			states.set(id, state);
			for (const observation of network.live('contracts:state'))
				if (observation.args.id === id) observation.update(state);
			if (selectedRead) publishSelected(id);
		},
		setState(id: string, state: ReturnType<typeof contract> | null) {
			states.set(id, state);
		},
		publishApproved(id = 'contract-a') {
			approvedReads.get(id)?.resolve(selectedPayload(id));
			publishSelected(id);
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
				headsAfter(states.get(write.request.id)?.playbook ?? [], write.request.commands),
				write.request.operationId
			);
			states.set(write.request.id, state);
			if (selectedRead) publishSelected(write.request.id);
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
	const latest: FunctionReturnType<typeof api.buyerLinkActions.ensureLatest> = {
		id: 'link' as Id<'buyerLinks'>,
		token: 'Ab3Cd4Ef5Gh6I',
		createdAt: 0,
		created: true
	};
	const query = vi.fn<Client['query']>().mockImplementation(async (ref) => {
		if (getFunctionName(ref) === 'buyerLinks:latest') return null;
		expect(getFunctionName(ref)).toBe('contracts:readiness');
		const state = current();
		return {
			ready: true,
			workBlock: null,
			blockers: [],
			blockerCount: 0,
			pagination: { isDone: true, continueCursor: '' },
			expectation: {
				stateRevision: state.stateRevision,
				documentId: state.documentId,
				documentRevision: state.documentRevision
			}
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
	headsAfter,
	template,
	draft,
	controllers,
	settle,
	fixture,
	show,
	buyerLinkFixture
};
