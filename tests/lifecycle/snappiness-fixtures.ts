import { getFunctionName } from 'convex/server';
import type { ConvexClient } from 'convex/browser';
import { flushSync, tick } from 'svelte';
import { vi } from 'vitest';
import type { Id } from '../../src/convex/_generated/dataModel';
import type { ContractBlock } from '../../src/lib/contract/model';
import type { ReadyContract } from '../../src/lib/document/runtime/resources.svelte';
import type {
	DetailRecord,
	DetailSnapshot,
	StructureSnapshot
} from '../../src/lib/playbook/structure';
import { itemStructure } from '../../src/lib/playbook/structure';

export const membershipId = 'member' as Id<'memberships'>;
export const companyId = 'company' as Id<'company'>;
export const watermark = {
	baselineFingerprint: 'baseline',
	authoringGeneration: 1,
	structuralGeneration: 1
};

export function documentFixture(count = 12) {
	const blocks: ContractBlock[] = Array.from({ length: count }, (_, i) => ({
		kind: 'paragraph',
		role: 'body',
		blockKey: `paragraph-${i}`,
		order: i,
		content: [
			{ kind: 'text', sourceKey: `text-${i}`, text: `Clause ${i}. Synthetic contract wording.` }
		]
	}));
	const records: DetailRecord[] = blocks.map((_, i) => ({
		_id: `item-${i}` as Id<'playbookItems'>,
		_creationTime: 1,
		companyId,
		contentRevision: 1,
		renderKey: `render-${i}`,
		instructions: { summary: `Summary ${i}` },
		approvalPolicy: { kind: 'none' },
		trigger: {
			id: `trigger-${i}`,
			target: {
				kind: 'text',
				range: {
					start: { sourceKey: `text-${i}`, offset: 0 },
					end: { sourceKey: `text-${i}`, offset: 6 }
				}
			}
		},
		concessions: [
			{ id: 'preferred', tier: 'preferred', description: 'Synthetic choice', changes: [] }
		]
	}));
	const structure: StructureSnapshot = {
		...watermark,
		ready: true,
		items: records.map((record) => itemStructure(record))
	};
	const detail = (i: number, record = records[i]): DetailSnapshot => ({
		...watermark,
		ready: true,
		status: 'present',
		item: record
	});
	return { blocks, records, structure, detail };
}

export function readyContract(
	snapshot: ReturnType<typeof documentFixture>,
	id = 'contract-a'
): ReadyContract {
	return {
		id,
		status: 'ready',
		contract: {
			_id: id as Id<'savedContracts'>,
			_creationTime: 1,
			companyId,
			creatorId: 'profile' as Id<'profiles'>,
			templateVersionId: 'version' as Id<'templateVersions'>,
			buyerCompanyName: 'Synthetic Buyer',
			savedAt: 1,
			applications: {},
			editRevision: 0,
			reviewGeneration: 0,
			stateVersion: 1,
			reviewCompletion: null,
			lastOperationId: null
		},
		snapshot: {
			blocks: snapshot.blocks,
			items: snapshot.records,
			blockCount: snapshot.blocks.length,
			itemCount: snapshot.records.length
		}
	};
}

export function deferred<T>() {
	let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

export function controlledClient() {
	type Observation = {
		name: string;
		args: { id?: string };
		update: (value: unknown) => void;
		error: (error: Error) => void;
		released: boolean;
	};
	const observations: Observation[] = [];
	const mutation = vi.fn(() => new Promise<never>(() => {}));
	const onUpdate = vi.fn((reference, args, update, error) => {
		const observation: Observation = {
			name: getFunctionName(reference),
			args,
			update,
			error,
			released: false
		};
		observations.push(observation);
		return () => {
			observation.released = true;
		};
	});
	const live = (name: string) => observations.filter((o) => o.name === name && !o.released);
	const details = () => live('playbookItems:detail');
	const publish = (name: string, value: unknown) => live(name).forEach((o) => o.update(value));
	const publishDetail = (id: string, value: DetailSnapshot) =>
		details()
			.filter((o) => o.args.id === id)
			.forEach((o) => o.update(value));
	return {
		client: { onUpdate, mutation } as unknown as ConvexClient,
		observations,
		mutation,
		onUpdate,
		live,
		details,
		publish,
		publishDetail
	};
}

// Drain Svelte/microtasks only. No clocks or transport responses advance implicitly.
export async function settle() {
	for (let i = 0; i < 5; i++) {
		flushSync();
		await tick();
		await Promise.resolve();
	}
}

export function frameClock() {
	let id = 0;
	const frames = new Map<number, FrameRequestCallback>();
	vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
		frames.set(++id, callback);
		return id;
	});
	vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
	return {
		frames,
		async frame() {
			const batch = [...frames.values()];
			frames.clear();
			for (const callback of batch) callback(performance.now());
			await settle();
		}
	};
}
