import type { Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { unreadEntry } from './discussionIndexValidators';
import {
	DiscussionTree,
	treeSize as size,
	type TreeNode,
	type TreeReference as Reference,
	type StoredTreeRow
} from './discussionTree';

export type UnreadEntry = Infer<typeof unreadEntry>;
export type { DiscussionOwner, DiscussionRoot as UnreadRoot } from './discussionTree';
type Child = {
	orderKey?: string;
	nodeId: Reference;
	end: number;
	threadId: Id<'discussionThreads'>;
	maximumStart: number;
	witnessThreadId: Id<'discussionThreads'>;
};
type Node = TreeNode<UnreadEntry, Child>;
const compare = (
	a: Pick<UnreadEntry, 'end' | 'threadId' | 'orderKey'>,
	b: Pick<UnreadEntry, 'end' | 'threadId' | 'orderKey'>
) =>
	a.end - b.end ||
	((a.orderKey ?? a.threadId) < (b.orderKey ?? b.threadId)
		? -1
		: (a.orderKey ?? a.threadId) === (b.orderKey ?? b.threadId)
			? 0
			: 1);

function summary(nodeId: Reference, node: Node): Child {
	if (!size(node)) throw new Error('An empty unread node cannot have a parent.');
	const last = node.kind === 'leaf' ? node.entries.at(-1)! : node.children.at(-1)!;
	let maximumStart = -Infinity,
		witnessThreadId = last.threadId;
	for (const entry of node.kind === 'leaf' ? node.entries : node.children) {
		const start = 'start' in entry ? entry.start : entry.maximumStart;
		const witness = 'start' in entry ? entry.threadId : entry.witnessThreadId;
		if (start > maximumStart || (start === maximumStart && witness < witnessThreadId)) {
			maximumStart = start;
			witnessThreadId = witness;
		}
	}
	return {
		nodeId,
		end: last.end,
		threadId: last.threadId,
		...(last.orderKey ? { orderKey: last.orderKey } : {}),
		maximumStart,
		witnessThreadId
	};
}

/** Exact unread queries over the shared mutation-local tree storage. */
export class DiscussionUnreadTree extends DiscussionTree<
	Pick<UnreadEntry, 'end' | 'threadId' | 'orderKey'>,
	UnreadEntry,
	Child
> {
	protected readonly lane = 'unread';
	protected readonly compare = compare;
	protected readonly summary = summary;
	protected decode(row: Doc<'discussionUnreadNodes'>): Node {
		if (row.lane !== this.lane) throw new Error('Unread tree ownership is invalid.');
		return row.kind === 'leaf'
			? { kind: 'leaf', entries: row.entries }
			: { kind: 'branch', children: row.children };
	}
	protected encode(
		node: TreeNode<UnreadEntry, Child & { nodeId: Id<'discussionUnreadNodes'> }>
	): StoredTreeRow {
		return { ...this.owner, lane: this.lane, revision: this.revision, ...node };
	}
	/** Stable ordering keys let prepared insertions bind the allocated business ID without another tree traversal. */
	bindThreadId(before: Id<'discussionThreads'>, after: Id<'discussionThreads'>) {
		for (const node of this.nodes.values()) {
			for (const entry of node.kind === 'leaf' ? node.entries : node.children) {
				if (entry.threadId === before) entry.threadId = after;
				if ('witnessThreadId' in entry && entry.witnessThreadId === before)
					entry.witnessThreadId = after;
			}
		}
	}
	/** max(start among end <= bound) >= minimumStart iff one entire unread
	 * passage lies in this unchanged gap. Removing command-local entries in an
	 * O(k*height) summary overlay prevents a removed maximum hiding another entry. */
	async prefixWitness(
		bound: number,
		minimumStart: number,
		excluding: readonly UnreadEntry[] = []
	): Promise<Id<'discussionThreads'> | null> {
		if (!this.root) return null;
		const overlay = new Map<Reference, Node>();
		const get = async (id: Reference) => overlay.get(id) ?? this.load(id);
		const omit = async (id: Reference, entry: UnreadEntry): Promise<boolean> => {
			const original = await get(id),
				node = structuredClone(original);
			if (node.kind === 'leaf') {
				const at = node.entries.findIndex((row) => compare(row, entry) === 0);
				if (at < 0) return false;
				node.entries.splice(at, 1);
			} else {
				if (!node.children.length) return false;
				const at = this.childPosition(node.children, entry),
					childId = node.children[at].nodeId;
				if (!(await omit(childId, entry))) return false;
				const child = await get(childId);
				if (size(child)) node.children[at] = summary(childId, child);
				else node.children.splice(at, 1);
			}
			overlay.set(id, node);
			return true;
		};
		for (const entry of excluding) await omit(this.root, entry);
		const query = async (id: Reference): Promise<Id<'discussionThreads'> | null> => {
			const node = await get(id);
			if (node.kind === 'leaf') {
				let maximum: UnreadEntry | undefined;
				for (const entry of node.entries) {
					if (entry.end > bound) break;
					if (entry.start >= minimumStart && (!maximum || entry.start > maximum.start))
						maximum = entry;
				}
				return maximum?.threadId ?? null;
			}
			for (const child of node.children) {
				if (child.end <= bound) {
					if (child.maximumStart >= minimumStart) return child.witnessThreadId;
				} else return query(child.nodeId);
			}
			return null;
		};
		return query(this.root);
	}
}
