import type { Infer } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { supportEntry, supportCounts, supportTreeCursor } from './discussionIndexValidators';
import {
	DiscussionTree,
	treeSize as size,
	type TreeNode,
	type TreeReference as Reference,
	type StoredTreeRow
} from './discussionTree';

export type SupportEntry = Infer<typeof supportEntry>;
export type { DiscussionOwner, DiscussionRoot as SupportRoot } from './discussionTree';
type Child = {
	nodeId: Reference;
	end: number;
	threadId: Id<'discussionThreads'>;
	minimumStart: number;
	maximumStart: number;
	supportCount: number;
	pendingCount: number;
	declinedCount: number;
	withAppliedCount: number;
	minimumAdmission: number;
	maximumAdmission: number;
};
type Node = TreeNode<SupportEntry, Child>;
const compare = (
	a: Pick<SupportEntry, 'end' | 'threadId'>,
	b: Pick<SupportEntry, 'end' | 'threadId'>
) => a.end - b.end || (a.threadId < b.threadId ? -1 : a.threadId === b.threadId ? 0 : 1);

export type SupportCounts = Infer<typeof supportCounts>;
export type SupportTreeCursor = Infer<typeof supportTreeCursor>;
export const emptySupportCounts = (): SupportCounts => ({
	supportCount: 0,
	pendingCount: 0,
	declinedCount: 0,
	withAppliedCount: 0,
	coveredPendingCount: 0
});
export function supportEntryCounts(entry: SupportEntry, cutoff?: number): SupportCounts {
	const pending = entry.status === 'pending';
	return {
		supportCount: 1,
		pendingCount: pending ? 1 : 0,
		declinedCount: pending ? 0 : 1,
		withAppliedCount: entry.withApplied ? 1 : 0,
		coveredPendingCount:
			pending && cutoff !== undefined && entry.admissionRevision <= cutoff ? 1 : 0
	};
}
export function addSupportCounts(total: SupportCounts, next: SupportCounts, sign = 1) {
	for (const key of Object.keys(total) as (keyof SupportCounts)[]) total[key] += next[key] * sign;
	return total;
}
function summary(nodeId: Reference, node: Node): Child {
	if (!size(node)) throw new Error('An empty support node cannot have a parent.');
	const last = node.kind === 'leaf' ? node.entries.at(-1)! : node.children.at(-1)!;
	const result: Child = {
		nodeId,
		end: last.end,
		threadId: last.threadId,
		minimumStart: Infinity,
		maximumStart: -Infinity,
		supportCount: 0,
		pendingCount: 0,
		declinedCount: 0,
		withAppliedCount: 0,
		minimumAdmission: Infinity,
		maximumAdmission: -Infinity
	};
	for (const entry of node.kind === 'leaf' ? node.entries : node.children) {
		const child =
			'start' in entry
				? {
						minimumStart: entry.start,
						maximumStart: entry.start,
						...supportEntryCounts(entry),
						minimumAdmission: entry.status === 'pending' ? entry.admissionRevision : Infinity,
						maximumAdmission: entry.status === 'pending' ? entry.admissionRevision : -Infinity
					}
				: entry;
		result.minimumStart = Math.min(result.minimumStart, child.minimumStart);
		result.maximumStart = Math.max(result.maximumStart, child.maximumStart);
		result.supportCount += child.supportCount;
		result.pendingCount += child.pendingCount;
		result.declinedCount += child.declinedCount;
		result.withAppliedCount += child.withAppliedCount;
		if (child.pendingCount) {
			result.minimumAdmission = Math.min(result.minimumAdmission, child.minimumAdmission);
			result.maximumAdmission = Math.max(result.maximumAdmission, child.maximumAdmission);
		}
	}
	if (!result.pendingCount) result.minimumAdmission = result.maximumAdmission = 0;
	return result;
}

/** Exact support queries over the shared mutation-local tree storage. */
export class DiscussionSupportTree extends DiscussionTree<
	Pick<SupportEntry, 'end' | 'threadId'>,
	SupportEntry,
	Child
> {
	protected readonly lane = 'support';
	protected readonly compare = compare;
	protected readonly summary = summary;
	protected decode(row: Doc<'discussionUnreadNodes'>): Node {
		if (row.lane !== this.lane) throw new Error('Support tree ownership is invalid.');
		return row.kind === 'leaf'
			? { kind: 'leaf', entries: row.entries }
			: { kind: 'branch', children: row.children };
	}
	protected encode(
		node: TreeNode<SupportEntry, Child & { nodeId: Id<'discussionUnreadNodes'> }>
	): StoredTreeRow {
		return { ...this.owner, lane: this.lane, revision: this.revision, ...node };
	}
	async get(entry: Pick<SupportEntry, 'end' | 'threadId'>): Promise<SupportEntry | null> {
		if (!this.root) return null;
		let id = this.root;
		for (;;) {
			const node = await this.load(id);
			if (node.kind === 'leaf')
				return node.entries.find((row) => compare(row, entry) === 0) ?? null;
			id = node.children[this.childPosition(node.children, entry)].nodeId;
		}
	}
	/** One persisted-node step. End bounds clip boundary children before summaries
	 * are consumed. Mixed starts/admission cutoffs descend, including overlapping
	 * declined supports; no disjoint-claim assumption enters this fold. */
	async foldStep(
		start: number,
		end: number,
		cutoff: number | undefined,
		cursor?: SupportTreeCursor,
		excluding: readonly SupportEntry[] = []
	): Promise<{ cursor: SupportTreeCursor; done: boolean; counts: SupportCounts }> {
		const next: SupportTreeCursor = {
			frames: cursor
				? cursor.frames.map((frame) => ({ ...frame }))
				: this.root
					? [{ nodeId: this.root as Id<'discussionUnreadNodes'>, position: 0 }]
					: []
		};
		const counts = emptySupportCounts();
		if (!next.frames.length) return { cursor: next, done: true, counts };
		const frame = next.frames.at(-1)!;
		const node = await this.load(frame.nodeId);
		if (node.kind === 'leaf') {
			for (const entry of node.entries) {
				if (entry.end > end) break;
				if (
					entry.start >= start &&
					!excluding.some(
						(omit) =>
							omit.threadId === entry.threadId &&
							omit.changeId === entry.changeId &&
							omit.decisionId === entry.decisionId
					)
				)
					addSupportCounts(counts, supportEntryCounts(entry, cutoff));
			}
			next.frames.pop();
		} else {
			const child = node.children[frame.position++];
			if (!child) next.frames.pop();
			else {
				const lower = frame.position > 1 ? node.children[frame.position - 2] : null;
				const omitted = excluding.some(
					(entry) => compare(entry, child) <= 0 && (!lower || compare(entry, lower) > 0)
				);
				if (child.maximumStart >= start && (!lower || lower.end <= end)) {
					const uniformCoverage =
						cutoff === undefined ||
						!child.pendingCount ||
						child.maximumAdmission <= cutoff ||
						child.minimumAdmission > cutoff;
					if (child.end <= end && child.minimumStart >= start && uniformCoverage && !omitted)
						addSupportCounts(counts, {
							supportCount: child.supportCount,
							pendingCount: child.pendingCount,
							declinedCount: child.declinedCount,
							withAppliedCount: child.withAppliedCount,
							coveredPendingCount:
								cutoff !== undefined && child.pendingCount && child.maximumAdmission <= cutoff
									? child.pendingCount
									: 0
						});
					else
						next.frames.push({ nodeId: child.nodeId as Id<'discussionUnreadNodes'>, position: 0 });
				}
			}
		}
		return { cursor: next, done: next.frames.length === 0, counts };
	}
}
