import { getConvexSize, type Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { storedUnreadNode } from './discussionIndexValidators';

export type DiscussionOwner = { companyId: Id<'company'>; contractId: Id<'savedContracts'> };
export type DiscussionRoot = { rootId: Id<'discussionUnreadNodes'>; height: number };
export type TreeReference = string;
export type TreeNode<Entry, Child> =
	{ kind: 'leaf'; entries: Entry[] } | { kind: 'branch'; children: Child[] };
export type StoredTreeRow = Infer<typeof storedUnreadNode>;
type Reference = TreeReference;
const MAX = 16,
	MIN = 8;
export const treeSize = <Entry, Child>(node: TreeNode<Entry, Child>) =>
	node.kind === 'leaf' ? node.entries.length : node.children.length;

/** Mutation-local B+ storage shared by the two exact discussion lanes. Lane owners
 * supply ordering, summaries and typed row conversion, and keep their own queries. */
export abstract class DiscussionTree<
	Key,
	Entry extends Key & { start: number; end: number },
	Child extends Key & { nodeId: Reference }
> {
	protected readonly nodes = new Map<Reference, TreeNode<Entry, Child>>();
	private readonly dirty = new Set<Reference>();
	private readonly removed = new Set<Reference>();
	private nextTemporary = 0;
	protected root: Reference | null;
	private height: number;
	protected abstract readonly lane: 'unread' | 'support';
	protected abstract readonly compare: (a: Key, b: Key) => number;
	protected abstract readonly summary: (id: Reference, node: TreeNode<Entry, Child>) => Child;
	protected abstract decode(row: Doc<'discussionUnreadNodes'>): TreeNode<Entry, Child>;
	protected abstract encode(
		node: TreeNode<Entry, Child & { nodeId: Id<'discussionUnreadNodes'> }>
	): StoredTreeRow;
	constructor(
		private readonly ctx: QueryCtx,
		protected readonly owner: DiscussionOwner,
		protected readonly revision: number,
		root: DiscussionRoot | null,
		private readonly admitRead?: () => Promise<void>
	) {
		this.root = root?.rootId ?? null;
		this.height = root?.height ?? 0;
	}
	private get label() {
		return this.lane === 'unread' ? 'Unread' : 'Support';
	}
	protected childPosition(children: Child[], entry: Key) {
		const found = children.findIndex((child) => this.compare(child, entry) >= 0);
		return found < 0 ? children.length - 1 : found;
	}
	protected async load(id: Reference): Promise<TreeNode<Entry, Child>> {
		if (this.removed.has(id)) throw new Error(`${this.label} tree references a retired node.`);
		let node = this.nodes.get(id);
		if (node) return node;
		await this.admitRead?.();
		const row = await this.ctx.db.get('discussionUnreadNodes', id as Id<'discussionUnreadNodes'>);
		if (
			!row ||
			row.companyId !== this.owner.companyId ||
			row.contractId !== this.owner.contractId ||
			row.revision !== this.revision
		)
			throw new Error(`${this.label} tree ownership is invalid.`);
		node = this.decode(row);
		if (!treeSize(node) || treeSize(node) > MAX)
			throw new Error(`${this.label} tree node occupancy is invalid.`);
		this.nodes.set(id, node);
		return node;
	}
	private async storedRow(
		node: TreeNode<Entry, Child>,
		resolve: (id: Reference) => Promise<Id<'discussionUnreadNodes'>>
	): Promise<StoredTreeRow> {
		return this.encode(
			node.kind === 'leaf'
				? node
				: {
						kind: 'branch',
						children: await Promise.all(
							node.children.map(async (child) => ({
								...child,
								nodeId: await resolve(child.nodeId)
							}))
						)
					}
		);
	}
	private allocate(node: TreeNode<Entry, Child>) {
		const id = `new:${this.nextTemporary++}`;
		this.nodes.set(id, node);
		this.dirty.add(id);
		return id;
	}
	private retire(id: Reference) {
		this.dirty.delete(id);
		if (!id.startsWith('new:')) this.removed.add(id);
		this.nodes.delete(id);
	}
	async put(entry: Entry) {
		if (!(entry.start >= 0 && entry.end > entry.start))
			throw new Error(`${this.label} passage is empty.`);
		if (!this.root) {
			this.root = this.allocate({ kind: 'leaf', entries: [entry] });
			this.height = 1;
			return;
		}
		const insert = async (id: Reference): Promise<Reference | null> => {
			const node = await this.load(id);
			if (node.kind === 'leaf') {
				const at = node.entries.findIndex((row) => this.compare(row, entry) >= 0);
				if (at >= 0 && this.compare(node.entries[at], entry) === 0) node.entries[at] = entry;
				else node.entries.splice(at < 0 ? node.entries.length : at, 0, entry);
			} else {
				const at = this.childPosition(node.children, entry),
					child = node.children[at].nodeId;
				const split = await insert(child);
				node.children[at] = this.summary(child, await this.load(child));
				if (split) node.children.splice(at + 1, 0, this.summary(split, await this.load(split)));
			}
			this.dirty.add(id);
			if (treeSize(node) <= MAX) return null;
			const right: TreeNode<Entry, Child> =
				node.kind === 'leaf'
					? { kind: 'leaf', entries: node.entries.splice(MIN) }
					: { kind: 'branch', children: node.children.splice(MIN) };
			return this.allocate(right);
		};
		const split = await insert(this.root);
		if (split) {
			this.root = this.allocate({
				kind: 'branch',
				children: [
					this.summary(this.root, await this.load(this.root)),
					this.summary(split, await this.load(split))
				]
			});
			this.height++;
		}
	}
	async remove(entry: Key) {
		if (!this.root) return false;
		const erase = async (id: Reference): Promise<boolean> => {
			const node = await this.load(id);
			if (node.kind === 'leaf') {
				const at = node.entries.findIndex((row) => this.compare(row, entry) === 0);
				if (at < 0) return false;
				node.entries.splice(at, 1);
			} else {
				const at = this.childPosition(node.children, entry),
					childId = node.children[at].nodeId;
				if (!(await erase(childId))) return false;
				const child = await this.load(childId);
				if (treeSize(child) >= MIN || node.children.length === 1) {
					if (treeSize(child)) node.children[at] = this.summary(childId, child);
					else {
						this.retire(childId);
						node.children.splice(at, 1);
					}
				} else {
					const leftAt = at > 0 ? at - 1 : at;
					const leftId = node.children[leftAt].nodeId,
						rightId = node.children[leftAt + 1].nodeId;
					const left = await this.load(leftId),
						right = await this.load(rightId);
					if (left.kind !== right.kind) throw new Error(`${this.label} tree levels differ.`);
					const total = treeSize(left) + treeSize(right);
					if (left.kind === 'leaf' && right.kind === 'leaf') {
						const entries = [...left.entries, ...right.entries];
						left.entries = total <= MAX ? entries : entries.slice(0, Math.floor(total / 2));
						right.entries = total <= MAX ? [] : entries.slice(Math.floor(total / 2));
					} else if (left.kind === 'branch' && right.kind === 'branch') {
						const children = [...left.children, ...right.children];
						left.children = total <= MAX ? children : children.slice(0, Math.floor(total / 2));
						right.children = total <= MAX ? [] : children.slice(Math.floor(total / 2));
					}
					this.dirty.add(leftId);
					node.children[leftAt] = this.summary(leftId, left);
					if (total <= MAX) {
						this.retire(rightId);
						node.children.splice(leftAt + 1, 1);
					} else {
						this.dirty.add(rightId);
						node.children[leftAt + 1] = this.summary(rightId, right);
					}
				}
			}
			this.dirty.add(id);
			return true;
		};
		if (!(await erase(this.root))) return false;
		while (this.root) {
			const node = await this.load(this.root);
			if (!treeSize(node)) {
				this.retire(this.root);
				this.root = null;
				this.height = 0;
			} else if (node.kind === 'branch' && node.children.length === 1) {
				const child = node.children[0].nodeId;
				this.retire(this.root);
				this.root = child;
				this.height--;
			} else break;
		}
		return true;
	}

	/** Plan every changed node before native business writes. New IDs have the same
	 * encoded width as the IDs allocated by flush; branch summaries are already final. */
	async prepareFlush() {
		let documents = this.removed.size,
			bytes = this.removed.size * 128;
		const visited = new Set<Reference>();
		const visit = async (id: Reference): Promise<Id<'discussionUnreadNodes'>> => {
			if (!this.dirty.has(id)) return id as Id<'discussionUnreadNodes'>;
			if (visited.has(id)) throw new Error('Tree contains duplicate dirty references.');
			visited.add(id);
			const node = await this.load(id);
			const row = await this.storedRow(node, visit);
			if (!treeSize(node) || treeSize(node) > MAX || getConvexSize(row) > 8 * 1024)
				throw new Error('Tree storage invariant failed before commit.');
			documents++;
			bytes += getConvexSize(row) + 128;
			return (id.startsWith('new:') ? 'x'.repeat(32) : id) as Id<'discussionUnreadNodes'>;
		};
		const rootId = this.root ? await visit(this.root) : null;
		return {
			documents,
			bytes,
			root: rootId ? { rootId: rootId as Id<'discussionUnreadNodes'>, height: this.height } : null
		};
	}
	async flush(ctx: MutationCtx): Promise<DiscussionRoot | null> {
		const saved = new Map<Reference, Id<'discussionUnreadNodes'>>();
		const write = async (id: Reference): Promise<Id<'discussionUnreadNodes'>> => {
			const existing = saved.get(id);
			if (existing) return existing;
			if (!this.dirty.has(id)) return id as Id<'discussionUnreadNodes'>;
			const node = await this.load(id);
			const row = await this.storedRow(node, write);
			if (!treeSize(node) || treeSize(node) > MAX || getConvexSize(row) > 8 * 1024)
				throw new Error(`${this.label} tree storage invariant failed.`);
			const actual = id.startsWith('new:')
				? await ctx.db.insert('discussionUnreadNodes', row)
				: (id as Id<'discussionUnreadNodes'>);
			if (!id.startsWith('new:')) await ctx.db.replace('discussionUnreadNodes', actual, row);
			saved.set(id, actual);
			return actual;
		};
		const rootId = this.root ? await write(this.root) : null;
		for (const id of this.removed)
			await ctx.db.delete('discussionUnreadNodes', id as Id<'discussionUnreadNodes'>);
		// This transaction owner must create a fresh cache after adopting these IDs.
		return rootId ? { rootId, height: this.height } : null;
	}
}
