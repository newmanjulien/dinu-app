import { getContext, setContext } from 'svelte';
import type { ConvexClient } from 'convex/browser';
import type { Id } from '../../convex/_generated/dataModel';
import { api } from '../../convex/_generated/api';
import { afterStartupPaint } from './startup-perf';
import { recordStartup } from './startup-perf';
import {
	WorkspaceReadStorage,
	copyWorkspaceReadRows,
	WORKSPACE_READ_MAX_AGE,
	purgeWorkspaceReadStorage,
	type WorkspaceReadKey,
	type WorkspaceReadRows,
	type WorkspaceReadScope,
	type WorkspaceReadSnapshot,
	type WorkspaceDirectory,
	type WorkspaceDirectoryKey
} from './workspace-read-storage';

type Snapshots = { [K in WorkspaceReadKey]?: WorkspaceReadSnapshot<K> };
type BrowsePage<K extends WorkspaceDirectoryKey> = {
	query: string;
	rows: WorkspaceReadRows[K];
	hasMore: boolean;
	changeVersion: number;
};
const keys = ['contracts', 'buyerLinks', 'colleagues', 'invitations'] as const;
const owners = new Set<WorkspaceReadSnapshots>();
const knownScopes = new Map<string, { userId: string; scope: WorkspaceReadScope }>();

function sameRows(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
	const a = Object.entries(left),
		b = Object.entries(right);
	return (
		a.length === b.length &&
		a.every(
			([key, value]) =>
				Object.hasOwn(right, key) && sameRows(value, (right as Record<string, unknown>)[key])
		)
	);
}

/** Scoped disk projections and complete local directories. Route pagers own live cursors. */
export class WorkspaceReadSnapshots {
	private values = $state.raw<Snapshots>({});
	private directories = $state.raw<{
		contracts?: WorkspaceDirectory<'contracts'>;
		buyerLinks?: WorkspaceDirectory<'buyerLinks'>;
	}>({});
	private browse = $state.raw<{ [K in WorkspaceDirectoryKey]?: BrowsePage<K> }>({});
	private directoryEpoch = { contracts: 0, buyerLinks: 0 };
	private directoryHydrating = new Map<WorkspaceDirectoryKey, Promise<void>>();
	private epochs = { contracts: 0, buyerLinks: 0, colleagues: 0, invitations: 0 };
	private hydrating = new Map<WorkspaceReadKey, Promise<void>>();
	private scheduled = new Map<WorkspaceReadKey, () => void>();
	readonly storage: WorkspaceReadStorage;
	private alive = true;
	private available = true;
	private manageMembers = false;
	private startupAllowed = $state(true);
	private changeVersion = $state(0);
	get localChangeVersion() {
		return this.changeVersion;
	}
	get allowsStartup() {
		return this.startupAllowed;
	}
	constructor(
		readonly scope: WorkspaceReadScope,
		readonly userId: string
	) {
		this.storage = new WorkspaceReadStorage(scope);
		owners.add(this);
		knownScopes.set(JSON.stringify(scope), { userId, scope });
	}
	get<K extends WorkspaceReadKey>(key: K): WorkspaceReadSnapshot<K> | undefined {
		if (!this.alive || !this.available || (key === 'invitations' && !this.manageMembers)) return;
		const value = this.values[key];
		return value && Date.now() - value.savedAt <= WORKSPACE_READ_MAX_AGE ? value : undefined;
	}
	getDirectory<K extends WorkspaceDirectoryKey>(key: K): WorkspaceDirectory<K> | undefined {
		if (!this.alive || !this.available) return;
		const value = this.directories[key];
		return value as WorkspaceDirectory<K> | undefined;
	}
	/** Keep the most recently viewed page for each list across route remounts. */
	getBrowse<K extends WorkspaceDirectoryKey>(key: K, query: string): BrowsePage<K> | undefined {
		if (!this.alive || !this.available) return;
		const value = this.browse[key] as BrowsePage<K> | undefined;
		return value?.query === query && value.changeVersion === this.changeVersion ? value : undefined;
	}
	rememberBrowse<K extends WorkspaceDirectoryKey>(
		key: K,
		query: string,
		rows: WorkspaceReadRows[K],
		hasMore: boolean
	) {
		if (!this.alive || !this.available) return;
		this.browse = {
			...this.browse,
			[key]: { query, rows, hasMore, changeVersion: this.changeVersion }
		};
	}
	hydrateDirectory(key: WorkspaceDirectoryKey): Promise<void> {
		if (!this.alive || !this.available || this.getDirectory(key)) return Promise.resolve();
		const pending = this.directoryHydrating.get(key);
		if (pending) return pending;
		const epoch = this.directoryEpoch[key];
		const started = Date.now();
		if (key === 'contracts') recordStartup('contracts-directory-read-start');
		const work = this.storage
			.readDirectory(key)
			.then((value) => {
				if (key === 'contracts')
					recordStartup(
						value ? 'contracts-directory-read-ready' : 'contracts-directory-read-unavailable',
						Date.now() - started
					);
				if (!value || !this.alive || !this.available || epoch !== this.directoryEpoch[key]) return;
				this.directories = { ...this.directories, [key]: value };
			})
			.catch(() => {
				if (key === 'contracts')
					recordStartup('contracts-directory-read-error', Date.now() - started);
			})
			.finally(() => {
				if (this.directoryHydrating.get(key) === work) this.directoryHydrating.delete(key);
			});
		this.directoryHydrating.set(key, work);
		return work;
	}
	/** A complete paginated scan replaces one directory atomically. Existing rows stay usable during refresh. */
	async syncDirectory(client: Pick<ConvexClient, 'query'>) {
		const membershipId = this.scope.membershipId as Id<'memberships'>;
		const sync = async (key: WorkspaceDirectoryKey) => {
			const epoch = ++this.directoryEpoch[key];
			try {
				const rows: unknown[] = [];
				let cursor: string | null = null;
				for (;;) {
					if (!this.alive || !this.available || epoch !== this.directoryEpoch[key]) return;
					const paginationOpts: { numItems: number; cursor: string | null } = {
						numItems: 100,
						cursor
					};
					const result: { page: unknown[]; isDone: boolean; continueCursor: string } =
						key === 'contracts'
							? await client.query(api.contracts.browse, {
									membershipId,
									search: '',
									paginationOpts
								})
							: await client.query(api.buyerLinks.browse, {
									membershipId,
									search: '',
									paginationOpts
								});
					rows.push(...result.page);
					if (result.isDone) break;
					if (result.continueCursor === cursor) return;
					cursor = result.continueCursor;
				}
				if (!this.alive || !this.available || epoch !== this.directoryEpoch[key]) return;
				const copied = copyWorkspaceReadRows(key, rows, true);
				if (!copied) return;
				const value = { savedAt: Date.now(), rows: copied };
				this.directories = { ...this.directories, [key]: value };
				this.storage.writeDirectory(
					key,
					copied,
					() => this.alive && this.available && epoch === this.directoryEpoch[key]
				);
			} catch {
				// The previous complete directory remains usable on transport failure.
			}
		};
		await Promise.all([sync('contracts'), sync('buyerLinks')]);
	}
	contractChanged = (id?: string, name?: string, deleted = false) => {
		this.changeVersion++;
		this.browse = {};
		this.invalidate('contracts', 'buyerLinks');
		for (const key of ['contracts', 'buyerLinks'] as const) {
			++this.directoryEpoch[key];
			const existing = this.getDirectory(key);
			if (!existing || !id) continue;
			const found = existing.rows.some((row) =>
				'_id' in row ? row._id === id : row.contractId === id
			);
			if (!found && !deleted && key === 'contracts') {
				this.directories = { ...this.directories, contracts: undefined };
				this.storage.clearDirectory(key);
				continue;
			}
			if (!found) continue;
			if (key === 'contracts') {
				const rows = existing.rows as WorkspaceReadRows['contracts'];
				const next = rows
					.filter((row) => !deleted || row._id !== id)
					.map((row) => (name && row._id === id ? { ...row, title: name } : row));
				this.directories = { ...this.directories, contracts: { savedAt: Date.now(), rows: next } };
				this.storage.writeDirectory('contracts', next, () => this.alive && this.available);
			} else {
				const rows = existing.rows as WorkspaceReadRows['buyerLinks'];
				const next = rows
					.filter((row) => !deleted || row.contractId !== id)
					.map((row) => (name && row.contractId === id ? { ...row, title: name } : row));
				this.directories = { ...this.directories, buyerLinks: { savedAt: Date.now(), rows: next } };
				this.storage.writeDirectory('buyerLinks', next, () => this.alive && this.available);
			}
		}
	};
	configure(manageMembers: boolean, available: boolean) {
		if (!this.alive) return;
		if (available !== this.available) {
			this.available = available;
			if (!available) {
				this.startupAllowed = false;
				this.clear();
			}
			this.storage.configure(available);
		}
		if (!manageMembers && this.manageMembers) this.invalidate('invitations');
		this.manageMembers = manageMembers;
	}
	/** Called by a destination after its live pager has been created; never awaited by rendering. */
	hydrate<K extends WorkspaceReadKey>(key: K): Promise<void> {
		if (
			!this.alive ||
			!this.available ||
			this.epochs[key] !== 0 ||
			this.get(key) ||
			(key === 'invitations' && !this.manageMembers)
		)
			return Promise.resolve();
		const pending = this.hydrating.get(key);
		if (pending) return pending;
		const epoch = this.epochs[key];
		const work = this.storage
			.read(key)
			.then((value) => {
				if (
					!this.alive ||
					!this.available ||
					epoch !== this.epochs[key] ||
					(key === 'invitations' && !this.manageMembers)
				)
					return;
				// A missing value and a failed optional read are indistinguishable here.
				// Leave disk state intact; a confirmed live page will replace it.
				if (value) this.values = { ...this.values, [key]: value };
			})
			.finally(() => {
				if (this.hydrating.get(key) === work) this.hydrating.delete(key);
			});
		this.hydrating.set(key, work);
		return work;
	}
	confirm<K extends WorkspaceReadKey>(key: K, rows: WorkspaceReadRows[K], hasMore: boolean) {
		if (!this.alive || !this.available || (key === 'invitations' && !this.manageMembers)) return;
		if (key === 'contracts') this.startupAllowed = false;
		const copied = copyWorkspaceReadRows(key, rows);
		if (!copied) {
			this.invalidate(key);
			return;
		}
		const previous = this.values[key];
		if (this.epochs[key] > 0 && previous?.hasMore === hasMore && sameRows(previous.rows, copied))
			return;
		const value = Object.freeze({
			version: 1 as const,
			key,
			complete: true as const,
			savedAt: Date.now(),
			hasMore,
			rows: copied
		});
		this.values = { ...this.values, [key]: value };
		this.schedule(key, value);
	}
	private schedule<K extends WorkspaceReadKey>(
		key: K,
		value: WorkspaceReadSnapshot<K> | undefined
	) {
		const epoch = ++this.epochs[key];
		this.scheduled.get(key)?.();
		if (typeof requestAnimationFrame === 'undefined') return;
		const cancel = afterStartupPaint(() => {
			if (!this.alive || !this.available || epoch !== this.epochs[key]) return;
			this.scheduled.delete(key);
			this.storage.write(
				key,
				value,
				() => this.alive && this.available && epoch === this.epochs[key]
			);
		});
		this.scheduled.set(key, cancel);
	}
	invalidate(...targets: WorkspaceReadKey[]) {
		if (!this.alive || !this.available) return;
		const values = { ...this.values };
		for (const key of targets) {
			if (key === 'contracts') this.startupAllowed = false;
			delete values[key];
			const epoch = ++this.epochs[key];
			this.scheduled.get(key)?.();
			this.scheduled.delete(key);
			this.storage.write(
				key,
				undefined,
				() => this.alive && this.available && epoch === this.epochs[key]
			);
		}
		this.values = values;
	}
	cancelReads = () => {
		for (const key of ['contracts', 'buyerLinks'] as const) this.directoryEpoch[key]++;
		this.directoryHydrating.clear();
		for (const key of keys) this.epochs[key]++;
		this.hydrating.clear();
		for (const cancel of this.scheduled.values()) cancel();
		this.scheduled.clear();
	};
	clear = () => {
		this.cancelReads();
		this.values = {};
		this.directories = {};
		this.browse = {};
	};
	purge = () => {
		forgetWorkspaceReadScope(this.scope);
	};
	destroy() {
		this.alive = false;
		this.cancelReads();
		this.values = {};
		this.directories = {};
		this.browse = {};
		this.storage.close();
		owners.delete(this);
	}
}

/** Remember disposed route owners until their account/workspace actually ends. */
function purgeScopes(
	matches: (entry: { userId: string; scope: WorkspaceReadScope }) => boolean,
	scope?: WorkspaceReadScope
) {
	const scopes = new Map<string, WorkspaceReadScope>();
	if (scope) scopes.set(JSON.stringify(scope), scope);
	for (const owner of owners) {
		if (!matches(owner)) continue;
		scopes.set(JSON.stringify(owner.scope), owner.scope);
		owner.destroy();
	}
	for (const [key, entry] of knownScopes) {
		if (!matches(entry)) continue;
		scopes.set(key, entry.scope);
		knownScopes.delete(key);
	}
	for (const scope of scopes.values()) purgeWorkspaceReadStorage(scope);
}
export const workspaceReadResources = {
	cancelReads: () => owners.forEach((owner) => owner.cancelReads()),
	clear: () => owners.forEach((owner) => owner.clear()),
	endSession: () => purgeScopes(() => true),
	forgetMembership: (userId: string) => purgeScopes((entry) => entry.userId === userId)
};
export function forgetWorkspaceReadScope(scope: WorkspaceReadScope) {
	const key = JSON.stringify(scope);
	purgeScopes((entry) => JSON.stringify(entry.scope) === key, scope);
}
const contextKey = Symbol('workspace-read-snapshots');
export const setWorkspaceReadSnapshots = (value: WorkspaceReadSnapshots) =>
	setContext(contextKey, value);
export const useWorkspaceReadSnapshots = () =>
	getContext<WorkspaceReadSnapshots | undefined>(contextKey);
