import { currentDecisionId, restoreAppliedHead, assertChangeHead } from './contractChangeHeads';
import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import {
	DiscussionMapReader,
	DiscussionPreparationRequired,
	type TransitionManifest
} from './discussionMaps';
import {
	DiscussionUnreadTree,
	type DiscussionOwner,
	type UnreadEntry
} from './discussionUnreadTree';
import { writeDirectoryUnread } from './contractDirectory';
import type { PassageInterval, SurvivingGap } from '../lib/discussions/tape';
import { getConvexSize, type Infer } from 'convex/values';
import { unreadProofCursor, supportProofCursor } from './discussionIndexValidators';
import {
	DiscussionSupportTree,
	addSupportCounts,
	emptySupportCounts,
	supportEntryCounts,
	type SupportEntry,
	type SupportCounts
} from './discussionSupportTree';

export type UnreadProofCursor = Infer<typeof unreadProofCursor>;
export type SupportProofCursor = Infer<typeof supportProofCursor>;

export type IndexedDiscussionRoot = Pick<
	Doc<'savedContracts'>,
	'_id' | 'companyId' | 'documentRevision'
>;
const intervalOf = (thread: Doc<'discussionThreads'>) => ({
	start: thread.passageStart,
	end: thread.passageEnd
});
const entryOf = (thread: Doc<'discussionThreads'>): UnreadEntry => ({
	...intervalOf(thread),
	threadId: thread._id,
	...(thread.unreadKey ? { orderKey: thread.unreadKey } : {})
});

/** One transaction/request owns this cache. It never grants access: construct it
 * only after the live contract/company access gate, and check row ownership. */
export class DiscussionIndex {
	readonly owner: DiscussionOwner;
	readonly maps: DiscussionMapReader;
	private readonly trees = new Map<number, DiscussionUnreadTree>();
	private readonly supportTrees = new Map<number, DiscussionSupportTree>();
	private readonly tapeLengths = new Map<number, number>();
	private readonly liveThreads = new Map<Id<'discussionThreads'>, Doc<'discussionThreads'>>();
	private changed = false;
	private generation: number;
	private supportGeneration: number;
	private storageGeneration: number;
	private counts: SupportCounts;
	private appliedBuyerCount: number;
	private request: Doc<'discussionUnreadControls'>['request'];
	private witnessId: Id<'discussionThreads'> | null;
	private constructor(
		private readonly ctx: QueryCtx,
		readonly root: IndexedDiscussionRoot,
		readonly control: Doc<'discussionUnreadControls'> | null,
		readonly events: Doc<'discussionInvalidations'>[],
		private readonly admitRead?: () => Promise<void>
	) {
		this.owner = { companyId: root.companyId, contractId: root._id };
		this.maps = new DiscussionMapReader(ctx, this.owner, admitRead);
		this.generation = control?.generation ?? 0;
		this.supportGeneration = control?.supportGeneration ?? 0;
		this.storageGeneration = control?.storageGeneration ?? 0;
		this.counts = { ...(control?.supportCounts ?? emptySupportCounts()) };
		this.appliedBuyerCount = control?.appliedBuyerCount ?? 0;
		this.request = control?.request;
		this.witnessId = control?.witnessThreadId ?? null;
		for (const cohort of control?.cohorts ?? [])
			this.tapeLengths.set(cohort.revision, cohort.tapeLength);
		for (const cohort of control?.supportCohorts ?? [])
			this.tapeLengths.set(cohort.revision, cohort.tapeLength);
	}
	static async open(ctx: QueryCtx, root: IndexedDiscussionRoot, admitRead?: () => Promise<void>) {
		const [control, events] = await Promise.all([
			ctx.db
				.query('discussionUnreadControls')
				.withIndex('by_contractId', (q) => q.eq('contractId', root._id))
				.unique(),
			ctx.db
				.query('discussionInvalidations')
				.withIndex('by_contractId_and_fromRevision', (q) => q.eq('contractId', root._id))
				.take(9)
		]);
		if (
			events.length > 8 ||
			(control?.cohorts.length ?? 0) > 9 ||
			(control?.supportCohorts.length ?? 0) > 9
		)
			throw new Error('Discussion cohort bound failed.');
		if (control && control.companyId !== root.companyId)
			throw new Error('Unread control ownership is invalid.');
		for (const [i, event] of events.entries()) {
			if (
				event.companyId !== root.companyId ||
				event.toRevision !== event.fromRevision + 1 ||
				(i && events[i - 1].toRevision !== event.fromRevision) ||
				event.toRevision > root.documentRevision
			)
				throw new Error('Discussion invalidation chain is invalid.');
		}
		return new DiscussionIndex(ctx, root, control, events, admitRead);
	}
	get indexGeneration() {
		return this.generation;
	}
	get supportIndexGeneration() {
		return this.supportGeneration;
	}
	get nativeStorageGeneration() {
		return this.storageGeneration;
	}
	get supportSummary() {
		return {
			...this.counts,
			appliedBuyerCount: this.appliedBuyerCount,
			reviewCount: this.appliedBuyerCount + this.counts.supportCount - this.counts.withAppliedCount,
			unsubmittedPendingCount: this.counts.pendingCount - this.counts.coveredPendingCount,
			requestActive: Boolean(this.request && this.counts.coveredPendingCount > 0),
			request: this.request ?? null
		};
	}
	advanceStorageGeneration() {
		this.storageGeneration++;
		this.changed = true;
	}
	private advanceSupportGeneration() {
		this.supportGeneration++;
		this.advanceStorageGeneration();
	}
	installSupportCounts(counts: SupportCounts) {
		if (
			Object.values(counts).some((count) => !Number.isSafeInteger(count) || count < 0) ||
			counts.pendingCount + counts.declinedCount !== counts.supportCount ||
			counts.withAppliedCount > counts.supportCount ||
			counts.coveredPendingCount > counts.pendingCount
		)
			throw new Error('Invalid effective buyer support counts.');
		this.counts = { ...counts };
		this.changed = true;
	}
	/** Request activation is constant-size; entries retain their admission revisions. */
	activateRequest(id: Id<'approvalRequests'>, cutoff: number) {
		if (!Number.isSafeInteger(cutoff) || cutoff < 0) throw new Error('Invalid request cutoff.');
		this.request = { id, cutoff };
		this.counts.coveredPendingCount = this.counts.pendingCount;
		this.advanceSupportGeneration();
	}
	/** Bind the allocated row after a prepared activation; this changes no counters
	 * or generation beyond the activation already measured by prepareFlush. */
	bindActivatedRequest(id: Id<'approvalRequests'>, cutoff: number) {
		if (
			!this.changed ||
			this.request?.cutoff !== cutoff ||
			this.counts.coveredPendingCount !== this.counts.pendingCount
		)
			throw new Error('Request activation was not prepared.');
		this.request = { id, cutoff };
	}
	changeAppliedBuyerCount(delta: number) {
		if (!delta) return;
		this.appliedBuyerCount += delta;
		if (!Number.isSafeInteger(this.appliedBuyerCount) || this.appliedBuyerCount < 0)
			throw new Error('Invalid applied buyer review count.');
		this.advanceSupportGeneration();
	}
	advanceGeneration() {
		this.generation++;
		this.changed = true;
	}
	owned(thread: Doc<'discussionThreads'>) {
		return thread.companyId === this.owner.companyId && thread.contractId === this.owner.contractId;
	}
	async thread(id: Id<'discussionThreads'>) {
		let thread = this.liveThreads.get(id);
		if (!thread) {
			await this.admitRead?.();
			const row = await this.ctx.db.get('discussionThreads', id);
			if (!row || !this.owned(row)) return null;
			thread = row;
			this.liveThreads.set(id, row);
		}
		return thread;
	}
	async interval(
		thread: Doc<'discussionThreads'>,
		additional?: TransitionManifest,
		throughRevision = this.root.documentRevision
	): Promise<PassageInterval | null> {
		if (
			!this.owned(thread) ||
			thread.tombstoned ||
			thread.indexedDocumentRevision > throughRevision
		)
			return null;
		let interval: PassageInterval | null = intervalOf(thread),
			revision = thread.indexedDocumentRevision;
		for (const event of this.events) {
			if (event.fromRevision < revision || event.toRevision > throughRevision) continue;
			if (event.fromRevision !== revision)
				throw new Error('A live discussion lost its coordinate map.');
			interval = await this.maps.passage(interval, event.map);
			if (!interval) return null;
			revision = event.toRevision;
		}
		if (revision !== throughRevision)
			throw new Error('A live discussion has an undrained revision gap.');
		return additional ? this.maps.passage(interval, additional) : interval;
	}
	/** Each yielded range is in the cohort's own coordinates, preserving every
	 * historical seam. The corresponding current interval permits claim inversion. */
	async *gaps(
		revision: number,
		tapeLength: number,
		additional?: TransitionManifest
	): AsyncGenerator<SurvivingGap> {
		const maps = this.events
			.filter((event) => event.fromRevision >= revision)
			.map((event) => event.map);
		if (additional) maps.push(additional);
		const advance = async function* (
			reader: DiscussionMapReader,
			gap: SurvivingGap,
			index: number
		): AsyncGenerator<SurvivingGap> {
			if (index === maps.length) {
				yield gap;
				return;
			}
			for await (const next of reader.gaps(maps[index])) {
				const start = Math.max(gap.currentStart, next.start),
					end = Math.min(gap.currentEnd, next.end);
				if (start < end)
					yield* advance(
						reader,
						{
							start: gap.start + start - gap.currentStart,
							end: gap.start + end - gap.currentStart,
							currentStart: next.currentStart + start - next.start,
							currentEnd: next.currentStart + end - next.start
						},
						index + 1
					);
			}
		};
		yield* advance(
			this.maps,
			{ start: 0, end: tapeLength, currentStart: 0, currentEnd: tapeLength },
			0
		);
	}
	private tree(revision: number, tapeLength?: number) {
		let tree = this.trees.get(revision);
		if (!tree) {
			const cohort = this.control?.cohorts.find((row) => row.revision === revision);
			const length =
				cohort?.tapeLength ??
				this.events.find((event) => event.fromRevision === revision)?.map.beforeLength ??
				tapeLength;
			if (length !== undefined) this.tapeLengths.set(revision, length);
			if (!cohort && !this.tapeLengths.has(revision))
				throw new Error('Unread cohort has no tape length.');
			tree = new DiscussionUnreadTree(
				this.ctx,
				this.owner,
				revision,
				cohort ?? null,
				this.admitRead
			);
			this.trees.set(revision, tree);
		}
		return tree;
	}
	private supportTree(revision: number, tapeLength?: number) {
		let tree = this.supportTrees.get(revision);
		if (!tree) {
			const cohort = this.control?.supportCohorts.find((row) => row.revision === revision);
			const length =
				cohort?.tapeLength ??
				this.tapeLengths.get(revision) ??
				this.events.find((event) => event.fromRevision === revision)?.map.beforeLength ??
				tapeLength;
			if (length === undefined) throw new Error('Support cohort has no tape length.');
			this.tapeLengths.set(revision, length);
			tree = new DiscussionSupportTree(
				this.ctx,
				this.owner,
				revision,
				cohort ?? null,
				this.admitRead
			);
			this.supportTrees.set(revision, tree);
		}
		return tree;
	}
	async supportEntry(thread: Doc<'discussionThreads'>) {
		if (!this.owned(thread)) throw new Error('Support thread ownership is invalid.');
		if (
			!this.supportTrees.has(thread.indexedDocumentRevision) &&
			!this.control?.supportCohorts.some(
				(cohort) => cohort.revision === thread.indexedDocumentRevision
			)
		)
			return null;
		return this.supportTree(thread.indexedDocumentRevision).get(entryOf(thread));
	}
	/** Direct writers supply exact old/new eligibility. Document-wide cancellation
	 * installs a sealed fold instead; maintenance never changes semantic counts. */
	async replaceSupport(
		thread: Doc<'discussionThreads'>,
		next: SupportEntry | null,
		tapeLength: number,
		eligibility: { old: boolean; next: boolean }
	) {
		if (
			!this.owned(thread) ||
			(next &&
				(next.threadId !== thread._id ||
					next.start !== thread.passageStart ||
					next.end !== thread.passageEnd))
		)
			throw new Error('Support entry coordinates are invalid.');
		const old = await this.supportEntry(thread);
		if (old) {
			if (!(await this.supportTree(thread.indexedDocumentRevision).remove(old)))
				throw new Error('Stored support entry disappeared.');
			if (eligibility.old)
				addSupportCounts(this.counts, supportEntryCounts(old, this.request?.cutoff), -1);
		} else if (eligibility.old)
			throw new Error('An effective floating support has no aggregate entry.');
		if (next) {
			await this.supportTree(thread.indexedDocumentRevision, tapeLength).put(next);
			if (eligibility.next)
				addSupportCounts(this.counts, supportEntryCounts(next, this.request?.cutoff));
		}
		this.installSupportCounts(this.counts);
		if (old || next) this.advanceSupportGeneration();
	}
	/** Normalize the exact physical head before its only map evidence can retire.
	 * A renewed head at different coordinates/IDs never matches this old entry. */
	private async normalizeSupport(ctx: MutationCtx, thread: Doc<'discussionThreads'>) {
		if (thread.type !== 'proposal') return;
		const entry = await this.supportEntry(thread);
		const head = await ctx.db
			.query('contractChangeHeads')
			.withIndex('by_contractId_and_kind_and_key', (q) =>
				q.eq('contractId', this.owner.contractId).eq('kind', 'buyer-link').eq('key', thread._id)
			)
			.unique();
		if (head && head.companyId !== this.owner.companyId)
			throw new Error('Support head ownership is invalid.');
		if (head) assertChangeHead(head);
		if (!entry) {
			if (head?.current && head.current.changeId !== head.applied?.changeId)
				throw new Error('A floating support lost its aggregate before normalization.');
			return;
		}
		if (
			head &&
			head.current?.changeId === entry.changeId &&
			currentDecisionId(head.current) === entry.decisionId &&
			head.current?.changeId !== head.applied?.changeId
		) {
			const change = await ctx.db.get('contractChanges', entry.changeId);
			if (
				!change ||
				change.companyId !== this.owner.companyId ||
				change.contractId !== this.owner.contractId ||
				change.kind !== 'buyer-link' ||
				change.source.threadId !== thread._id ||
				change.source.rootMessageId !== entry.rootMessageId ||
				change.source.rootRevision !== entry.rootRevision
			)
				throw new Error('Support normalization lost its exact source.');
			const restored = restoreAppliedHead(head);
			if (restored) await ctx.db.replace('contractChangeHeads', head._id, restored);
			else await ctx.db.delete('contractChangeHeads', head._id);
		}
		if (!(await this.supportTree(thread.indexedDocumentRevision).remove(entry)))
			throw new Error('Normalized support has no aggregate entry.');
		this.advanceSupportGeneration();
	}
	/** Prepare the exact unread overlay before the first business write. Even a
	 * positive-to-positive message revision advances both proof fences. */
	async prepareUnreadCount(thread: Doc<'discussionThreads'>, count: number, tapeLength: number) {
		if (!this.owned(thread) || thread.tombstoned || !Number.isSafeInteger(count) || count < 0)
			throw new Error('Invalid discussion unread count.');
		if (thread.unreadMessageCount === 0 && count > 0)
			await this.tree(thread.indexedDocumentRevision, tapeLength).put(entryOf(thread));
		if (
			thread.unreadMessageCount > 0 &&
			count === 0 &&
			!(await this.tree(thread.indexedDocumentRevision, tapeLength).remove(entryOf(thread)))
		)
			throw new Error('An unread thread has no aggregate entry.');
		const next = { ...thread, unreadMessageCount: count };
		this.liveThreads.set(thread._id, next);
		this.advanceGeneration();
		this.advanceStorageGeneration();
		if (count > 0 && (await this.interval(next))) this.witnessId = thread._id;
		return next;
	}
	bindThreadId(before: Id<'discussionThreads'>, after: Id<'discussionThreads'>) {
		for (const tree of this.trees.values()) tree.bindThreadId(before, after);
		const thread = this.liveThreads.get(before);
		if (thread) {
			this.liveThreads.delete(before);
			this.liveThreads.set(after, { ...thread, _id: after });
		}
		if (this.witnessId === before) this.witnessId = after;
	}
	async setUnreadCount(
		ctx: MutationCtx,
		thread: Doc<'discussionThreads'>,
		count: number,
		tapeLength: number
	) {
		const next = await this.prepareUnreadCount(thread, count, tapeLength);
		await ctx.db.patch('discussionThreads', thread._id, { unreadMessageCount: count });
		return next;
	}
	async rebase(
		ctx: MutationCtx,
		thread: Doc<'discussionThreads'>,
		revision: number,
		interval: PassageInterval,
		tapeLength: number
	) {
		if (!this.owned(thread) || thread.tombstoned || revision <= thread.indexedDocumentRevision)
			throw new Error('Invalid discussion rebase.');
		if (thread.unreadMessageCount > 0) {
			if (!(await this.tree(thread.indexedDocumentRevision).remove(entryOf(thread))))
				throw new Error('Rebased unread thread has no aggregate entry.');
			await this.tree(revision, tapeLength).put({
				...interval,
				threadId: thread._id,
				...(thread.unreadKey ? { orderKey: thread.unreadKey } : {})
			});
		}
		const support = await this.supportEntry(thread);
		if (support) {
			if (!(await this.supportTree(thread.indexedDocumentRevision).remove(support)))
				throw new Error('Rebased support has no aggregate entry.');
			await this.supportTree(revision, tapeLength).put({ ...support, ...interval });
			this.advanceSupportGeneration();
		}
		const claim = await ctx.db
			.query('discussionPassageClaims')
			.withIndex('by_threadId', (q) => q.eq('threadId', thread._id))
			.unique();
		if (claim) {
			if (claim.companyId !== this.owner.companyId || claim.contractId !== this.owner.contractId)
				throw new Error('Discussion claim ownership is invalid.');
			await ctx.db.patch('discussionPassageClaims', claim._id, {
				indexedDocumentRevision: revision,
				start: interval.start,
				end: interval.end
			});
		}
		const fields = {
			indexedDocumentRevision: revision,
			indexedTapeLength: tapeLength,
			passageStart: interval.start,
			passageEnd: interval.end
		};
		await ctx.db.patch('discussionThreads', thread._id, fields);
		this.liveThreads.set(thread._id, { ...thread, ...fields });
		this.advanceGeneration();
		this.advanceStorageGeneration();
	}
	async tombstone(ctx: MutationCtx, thread: Doc<'discussionThreads'>, unreadPrepared = false) {
		if (!this.owned(thread)) throw new Error('Discussion tombstone ownership is invalid.');
		if (thread.tombstoned) return;
		if (unreadPrepared && this.liveThreads.get(thread._id)?.unreadMessageCount !== 0)
			throw new Error('Discussion unread removal was not prepared.');
		await this.normalizeSupport(ctx, thread);
		if (
			thread.unreadMessageCount > 0 &&
			!unreadPrepared &&
			!(await this.tree(thread.indexedDocumentRevision).remove(entryOf(thread)))
		)
			throw new Error('Removed unread thread has no aggregate entry.');
		const claim = await ctx.db
			.query('discussionPassageClaims')
			.withIndex('by_threadId', (q) => q.eq('threadId', thread._id))
			.unique();
		if (claim) {
			if (claim.companyId !== this.owner.companyId || claim.contractId !== this.owner.contractId)
				throw new Error('Discussion claim ownership is invalid.');
			await ctx.db.delete('discussionPassageClaims', claim._id);
		}
		await ctx.db.patch('discussionThreads', thread._id, {
			tombstoned: true,
			unreadMessageCount: 0,
			cleanupDueAt: Date.now(),
			cleanupPhase: 'messages'
		});
		this.liveThreads.set(thread._id, {
			...thread,
			tombstoned: true,
			unreadMessageCount: 0,
			cleanupDueAt: Date.now(),
			cleanupPhase: 'messages'
		});
		this.advanceGeneration();
		this.advanceStorageGeneration();
	}
	async validWitness(
		additional?: TransitionManifest,
		excluding: readonly Doc<'discussionThreads'>[] = []
	) {
		if (!this.witnessId || excluding.some((thread) => thread._id === this.witnessId)) return null;
		const thread = await this.thread(this.witnessId);
		return thread && thread.unreadMessageCount > 0 && (await this.interval(thread, additional))
			? thread._id
			: null;
	}
	/** One resumable DFS step: at most nine map frames and one aggregate prefix query.
	 * Seeking each child at its parent's start avoids replaying earlier chunks. */
	async proofStep(
		cursor: UnreadProofCursor,
		additional?: TransitionManifest,
		excluding: readonly Doc<'discussionThreads'>[] = []
	): Promise<{
		cursor: UnreadProofCursor;
		done: boolean;
		witness: Id<'discussionThreads'> | null;
	}> {
		if (cursor.frames.length > 9) throw new Error('Unread proof depth exceeded its cohort bound.');
		const next: UnreadProofCursor = {
			cohort: cursor.cohort,
			frames: cursor.frames.map((frame) => ({
				...frame,
				gap: { ...frame.gap },
				...(frame.scan ? { scan: { ...frame.scan } } : {})
			}))
		};
		const revisions = [
			...new Set([
				...(this.control?.cohorts.map((cohort) => cohort.revision) ?? []),
				...this.trees.keys()
			])
		].sort((a, b) => a - b);
		const revision = revisions[next.cohort];
		if (revision === undefined) return { cursor: next, done: true, witness: null };
		const length = this.tapeLengths.get(revision);
		if (length === undefined) throw new Error('Unread proof cohort length is missing.');
		const maps = this.events
			.filter((event) => event.fromRevision >= revision)
			.map((event) => event.map);
		if (additional) maps.push(additional);
		if (!next.frames.length)
			next.frames.push({
				gap: { start: 0, end: length, currentStart: 0, currentEnd: length },
				mapIndex: 0
			});
		const frame = next.frames.at(-1)!;
		if (frame.mapIndex === maps.length) {
			const omissions = excluding
				.filter(
					(thread) => thread.indexedDocumentRevision === revision && thread.unreadMessageCount > 0
				)
				.map(entryOf);
			const witness = await this.tree(revision).prefixWitness(
				frame.gap.end,
				frame.gap.start,
				omissions
			);
			next.frames.pop();
			if (!next.frames.length) next.cohort++;
			return { cursor: next, done: Boolean(witness), witness };
		}
		const manifest = maps[frame.mapIndex];
		if (!frame.scan) frame.scan = await this.maps.gapCursor(manifest, frame.gap.currentStart);
		if (frame.scan.done || frame.scan.before >= frame.gap.currentEnd) {
			next.frames.pop();
			if (!next.frames.length) next.cohort++;
			return { cursor: next, done: false, witness: null };
		}
		const step = await this.maps.gapStep(manifest, frame.scan);
		frame.scan = step.cursor;
		if (step.gap) {
			const start = Math.max(frame.gap.currentStart, step.gap.start),
				end = Math.min(frame.gap.currentEnd, step.gap.end);
			if (start < end)
				next.frames.push({
					mapIndex: frame.mapIndex + 1,
					gap: {
						start: frame.gap.start + start - frame.gap.currentStart,
						end: frame.gap.start + end - frame.gap.currentStart,
						currentStart: step.gap.currentStart + start - step.gap.start,
						currentEnd: step.gap.currentStart + end - step.gap.start
					}
				});
		}
		return { cursor: next, done: false, witness: null };
	}
	async supportProofStep(
		cursor: SupportProofCursor,
		additional?: TransitionManifest,
		excluding: readonly Doc<'discussionThreads'>[] = []
	): Promise<{
		cursor: SupportProofCursor;
		done: boolean;
		counts: SupportCounts;
	}> {
		if (cursor.geometry.frames.length > 9)
			throw new Error('Unread proof depth exceeded its cohort bound.');
		const geometry: UnreadProofCursor = {
			cohort: cursor.geometry.cohort,
			frames: cursor.geometry.frames.map((frame) => ({
				...frame,
				gap: { ...frame.gap },
				...(frame.scan ? { scan: { ...frame.scan } } : {})
			}))
		};
		const next: SupportProofCursor = {
			geometry,
			counts: { ...cursor.counts },
			...(cursor.tree ? { tree: cursor.tree } : {})
		};
		const revisions = [
			...new Set([
				...(this.control?.supportCohorts.map((cohort) => cohort.revision) ?? []),
				...this.supportTrees.keys()
			])
		].sort((a, b) => a - b);
		const revision = revisions[geometry.cohort];
		if (revision === undefined) return { cursor: next, done: true, counts: next.counts };
		const length = this.tapeLengths.get(revision);
		if (length === undefined) throw new Error('Unread proof cohort length is missing.');
		const maps = this.events
			.filter((event) => event.fromRevision >= revision)
			.map((event) => event.map);
		if (additional) maps.push(additional);
		if (!geometry.frames.length)
			geometry.frames.push({
				gap: { start: 0, end: length, currentStart: 0, currentEnd: length },
				mapIndex: 0
			});
		const frame = geometry.frames.at(-1)!;
		if (frame.mapIndex === maps.length) {
			const omissions: SupportEntry[] = [];
			for (const thread of excluding)
				if (thread.indexedDocumentRevision === revision) {
					const entry = await this.supportEntry(thread);
					if (entry) omissions.push(entry);
				}
			const folded = await this.supportTree(revision).foldStep(
				frame.gap.start,
				frame.gap.end,
				this.request?.cutoff,
				next.tree,
				omissions
			);
			addSupportCounts(next.counts, folded.counts);
			if (folded.done) {
				delete next.tree;
				geometry.frames.pop();
				if (!geometry.frames.length) geometry.cohort++;
			} else next.tree = folded.cursor;
			return { cursor: next, done: false, counts: next.counts };
		}

		const manifest = maps[frame.mapIndex];
		if (!frame.scan) frame.scan = await this.maps.gapCursor(manifest, frame.gap.currentStart);
		if (frame.scan.done || frame.scan.before >= frame.gap.currentEnd) {
			geometry.frames.pop();
			if (!geometry.frames.length) geometry.cohort++;
			return { cursor: next, done: false, counts: next.counts };
		}
		const step = await this.maps.gapStep(manifest, frame.scan);
		frame.scan = step.cursor;
		if (step.gap) {
			const start = Math.max(frame.gap.currentStart, step.gap.start),
				end = Math.min(frame.gap.currentEnd, step.gap.end);
			if (start < end)
				geometry.frames.push({
					mapIndex: frame.mapIndex + 1,
					gap: {
						start: frame.gap.start + start - frame.gap.currentStart,
						end: frame.gap.start + end - frame.gap.currentStart,
						currentStart: step.gap.currentStart + start - step.gap.start,
						currentEnd: step.gap.currentStart + end - step.gap.start
					}
				});
		}
		return { cursor: next, done: false, counts: next.counts };
	}
	async effectiveSupportCounts(additional?: TransitionManifest) {
		let cursor: SupportProofCursor = {
			geometry: { cohort: 0, frames: [] },
			counts: emptySupportCounts()
		};
		for (;;) {
			await this.admitRead?.();
			const step = await this.supportProofStep(cursor, additional);
			if (step.done) return step.counts;
			cursor = step.cursor;
		}
	}

	async witness(
		additional?: TransitionManifest,
		excluding: readonly Doc<'discussionThreads'>[] = []
	): Promise<Id<'discussionThreads'> | null> {
		const excluded = new Set(excluding.map((thread) => thread._id));
		if (this.witnessId && !excluded.has(this.witnessId)) {
			const thread = await this.thread(this.witnessId);
			if (thread && thread.unreadMessageCount > 0 && (await this.interval(thread, additional)))
				return this.witnessId;
		}
		const revisions = new Set([
			...(this.control?.cohorts.map((cohort) => cohort.revision) ?? []),
			...this.trees.keys()
		]);
		for (const revision of revisions) {
			const length = this.tapeLengths.get(revision);
			if (length === undefined) throw new Error('Unread cohort length is missing.');
			const omissions = excluding
				.filter(
					(thread) => thread.indexedDocumentRevision === revision && thread.unreadMessageCount > 0
				)
				.map(entryOf);
			for await (const gap of this.gaps(revision, length, additional)) {
				const witness = await this.tree(revision).prefixWitness(gap.end, gap.start, omissions);
				if (witness) return witness;
			}
		}
		return null;
	}
	async recordTransition(ctx: MutationCtx, manifest: TransitionManifest) {
		if (this.events.length >= 8) throw new DiscussionPreparationRequired('event-slots');
		if (!manifest.inline && manifest.chunkCount <= 0)
			throw new Error('Cannot commit an unsealed discussion map.');
		await ctx.db.insert('discussionInvalidations', {
			...this.owner,
			fromRevision: this.root.documentRevision,
			toRevision: this.root.documentRevision + 1,
			map: manifest
		});
		this.advanceGeneration();
		this.advanceStorageGeneration();
	}
	/** Materialize tree edits in memory first, then measure their final control and
	 * node writes. flush only adopts this prepared shape after native IDs exist. */
	async prepareFlush(witness: Id<'discussionThreads'> | null, scheduling = false) {
		const cohorts = new Map((this.control?.cohorts ?? []).map((row) => [row.revision, row]));
		const supportCohorts = new Map(
			(this.control?.supportCohorts ?? []).map((row) => [row.revision, row])
		);
		let documents = 0,
			bytes = 0;
		for (const [trees, target] of [
			[this.trees, cohorts],
			[this.supportTrees, supportCohorts]
		] as const) {
			for (const [revision, tree] of trees) {
				const work = await tree.prepareFlush();
				documents += work.documents;
				bytes += work.bytes;
				if (work.root)
					target.set(revision, {
						revision,
						tapeLength: this.tapeLengths.get(revision)!,
						...work.root
					});
				else target.delete(revision);
			}
		}
		if (cohorts.size > 9 || supportCohorts.size > 9)
			throw new Error('Discussion cohort bound failed.');
		if (this.changed || this.control?.witnessThreadId !== witness || scheduling) {
			documents++;
			bytes +=
				getConvexSize({
					...this.owner,
					cohorts: [...cohorts.values()],
					supportCohorts: [...supportCohorts.values()],
					supportCounts: this.counts,
					appliedBuyerCount: this.appliedBuyerCount,
					supportGeneration: this.supportGeneration,
					storageGeneration: this.storageGeneration,
					...(this.request ? { request: this.request } : {}),
					generation: this.generation,
					witnessThreadId: witness,
					maintenanceGeneration: this.control?.maintenanceGeneration ?? 0,
					cleanupTurn: this.control?.cleanupTurn ?? false,
					...(scheduling ? { jobId: 'x'.repeat(32), dueAt: Date.now() } : {})
				}) + 1024;
		}
		return { documents, bytes };
	}
	/** Caller schedules/recoverably owns maintenance before committing an event,
	 * tombstone, or preparation; metadata is adopted here without a second control write. */
	async flush(
		ctx: MutationCtx,
		witness: Id<'discussionThreads'> | null,
		scheduling?: {
			jobId?: Id<'_scheduled_functions'>;
			dueAt?: number;
			maintenanceGeneration?: number;
			cleanupTurn?: boolean;
		},
		directory = true
	) {
		const cohorts = new Map(
			(this.control?.cohorts ?? []).map((cohort) => [cohort.revision, cohort])
		);
		const supportCohorts = new Map(
			(this.control?.supportCohorts ?? []).map((cohort) => [cohort.revision, cohort])
		);
		for (const [revision, tree] of this.trees) {
			const root = await tree.flush(ctx);
			if (root)
				cohorts.set(revision, { revision, tapeLength: this.tapeLengths.get(revision)!, ...root });
			else cohorts.delete(revision);
		}
		for (const [revision, tree] of this.supportTrees) {
			const root = await tree.flush(ctx);
			if (root)
				supportCohorts.set(revision, {
					revision,
					tapeLength: this.tapeLengths.get(revision)!,
					...root
				});
			else supportCohorts.delete(revision);
		}
		if (cohorts.size > 9 || supportCohorts.size > 9)
			throw new Error('Discussion cohort bound failed.');
		const fields = {
			...this.owner,
			cohorts: [...cohorts.values()].sort((a, b) => a.revision - b.revision),
			supportCohorts: [...supportCohorts.values()].sort((a, b) => a.revision - b.revision),
			supportCounts: this.counts,
			appliedBuyerCount: this.appliedBuyerCount,
			supportGeneration: this.supportGeneration,
			storageGeneration: this.storageGeneration,
			request: this.request,
			generation: this.generation,
			witnessThreadId: witness,
			maintenanceGeneration: this.control?.maintenanceGeneration ?? 0,
			cleanupTurn: this.control?.cleanupTurn ?? false,
			...scheduling
		};
		if (this.control) {
			if (this.changed || this.control.witnessThreadId !== witness || scheduling)
				await ctx.db.patch('discussionUnreadControls', this.control._id, fields);
		} else if (this.changed || witness || scheduling)
			await ctx.db.insert('discussionUnreadControls', fields);
		if (directory && Boolean(this.control?.witnessThreadId) !== Boolean(witness))
			await writeDirectoryUnread(ctx, this.owner.contractId, Boolean(witness));
		this.witnessId = witness;
	}
}
