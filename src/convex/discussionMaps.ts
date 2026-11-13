import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { getConvexSize, type Infer } from 'convex/values';
import { canonicalJson } from '../lib/document/canonical-json';
import {
	mapPassage,
	unchangedGaps,
	type DiscussionMap,
	type PassageInterval,
	type SurvivingGap
} from '../lib/discussions/tape';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { DiscussionOwner } from './discussionUnreadTree';
import { mapGapCursor, transitionManifest } from './discussionIndexValidators';

export type TransitionManifest = Infer<typeof transitionManifest>;
export type MapGapCursor = Infer<typeof mapGapCursor>;
export class DiscussionPreparationRequired extends Error {
	constructor(
		readonly reason: 'event-slots' | 'map-build' | 'unread-proof' | 'claim-probe' | 'capacity'
	) {
		super(`Discussion preparation required: ${reason}`);
		this.name = 'DiscussionPreparationRequired';
	}
}
export async function admitDiscussionWork(
	ctx: MutationCtx,
	work: {
		reads?: number;
		queries?: number;
		writes?: number;
		bytes?: number;
		readBytes?: number;
	} = {}
) {
	const metrics = await ctx.meta.getTransactionMetrics();
	if (
		metrics.documentsRead.remaining < (work.reads ?? 0) + 48 ||
		metrics.databaseQueries.remaining < (work.queries ?? 0) + 48 ||
		metrics.documentsWritten.remaining < (work.writes ?? 0) + 48 ||
		metrics.bytesWritten.remaining < (work.bytes ?? 0) + 1_000_000 ||
		metrics.bytesRead.remaining < (work.readBytes ?? 0) + 1_000_000 ||
		metrics.functionsScheduled.remaining < 1
	)
		throw new DiscussionPreparationRequired('capacity');
}
const digest = (value: unknown) =>
	bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))));

export const DISCUSSION_MAP_CHUNK_SPLICES = 32;
type MapChunk = Omit<Doc<'discussionTransitionMapChunks'>, '_id' | '_creationTime' | 'garbage'>;
export const discussionMapChunkHash = (
	previous: string,
	order: number,
	chunk: Pick<MapChunk, 'firstBefore' | 'startingDisplacement' | 'splices'>
) => digest([previous, order, chunk.firstBefore, chunk.startingDisplacement, chunk.splices]);

/** Identity binds actual old document + command/head dependencies and semantic geometry;
 * it contains no newly allocated change/event/receipt ID. */
export function discussionMapManifest(
	map: DiscussionMap,
	sourceIdentity: string
): TransitionManifest {
	validateMap(map);
	const geometryHash = digest([sourceIdentity, map]);
	let chunkHash = geometryHash,
		displacement = 0;
	for (let offset = 0; offset < map.splices.length; offset += DISCUSSION_MAP_CHUNK_SPLICES) {
		const splices = map.splices.slice(offset, offset + DISCUSSION_MAP_CHUNK_SPLICES);
		chunkHash = discussionMapChunkHash(chunkHash, offset / DISCUSSION_MAP_CHUNK_SPLICES, {
			firstBefore: splices[0].beforeStart,
			startingDisplacement: displacement,
			splices
		});
		const last = splices.at(-1)!;
		displacement = last.afterEnd - last.beforeEnd;
	}
	const manifest = {
		mapKey: `discussion:${geometryHash}`,
		geometryHash,
		chunkHash,
		spliceCount: map.splices.length,
		beforeLength: map.beforeLength,
		afterLength: map.afterLength,
		chunkCount: 0,
		bytes: getConvexSize(map.splices)
	};
	return getConvexSize({ ...manifest, inline: map.splices }) <= 4 * 1024
		? { ...manifest, inline: map.splices }
		: { ...manifest, chunkCount: -1 };
}
function validateMap(map: DiscussionMap) {
	let before = 0,
		after = 0;
	for (const splice of map.splices) {
		if (
			![splice.beforeStart, splice.beforeEnd, splice.afterStart, splice.afterEnd].every(
				Number.isSafeInteger
			) ||
			splice.beforeStart < before ||
			splice.afterStart < after ||
			splice.beforeEnd < splice.beforeStart ||
			splice.afterEnd < splice.afterStart ||
			splice.beforeStart - before !== splice.afterStart - after ||
			(splice.beforeStart === splice.beforeEnd && splice.afterStart === splice.afterEnd)
		)
			throw new Error('Discussion transition is not a canonical monotone map.');
		before = splice.beforeEnd;
		after = splice.afterEnd;
	}
	if (
		!Number.isSafeInteger(map.beforeLength) ||
		!Number.isSafeInteger(map.afterLength) ||
		map.beforeLength < before ||
		map.afterLength < after ||
		map.beforeLength - before !== map.afterLength - after
	)
		throw new Error('Discussion transition lengths do not match.');
}
export type MapBuildCursor = {
	splice: number;
	chunkCount: number;
	bytes: number;
	displacement: number;
	hash: string;
};

export function initialDiscussionMapCursor(manifest: TransitionManifest): MapBuildCursor {
	return { splice: 0, chunkCount: 0, bytes: 0, displacement: 0, hash: manifest.geometryHash };
}
export function sealedDiscussionMap(manifest: TransitionManifest, cursor?: MapBuildCursor) {
	return Boolean(
		manifest.inline ||
		(cursor &&
			cursor.splice === manifest.spliceCount &&
			cursor.chunkCount === Math.ceil(manifest.spliceCount / DISCUSSION_MAP_CHUNK_SPLICES) &&
			manifest.chunkCount === cursor.chunkCount &&
			manifest.chunkCount > 0 &&
			manifest.bytes === cursor.bytes &&
			cursor.displacement === manifest.afterLength - manifest.beforeLength &&
			cursor.hash === manifest.chunkHash)
	);
}

/** Current receipt metadata and committed events are the only geometry owners.
 * Exact indexed lookups also fence deletion against concurrent owner acquisition. */
export async function discussionMapOwned(ctx: QueryCtx, owner: DiscussionOwner, mapKey: string) {
	const event = await ctx.db
		.query('discussionInvalidations')
		.withIndex('by_contractId_and_map_mapKey', (q) =>
			q.eq('contractId', owner.contractId).eq('map.mapKey', mapKey)
		)
		.first();
	if (event) {
		if (event.companyId !== owner.companyId)
			throw new Error('Discussion map event ownership is invalid.');
		return true;
	}
	const receipt = await ctx.db
		.query('operationReceipts')
		.withIndex('by_contractId_and_state_and_preparation_map_mapKey', (q) =>
			q
				.eq('contractId', owner.contractId)
				.eq('state', 'preparing')
				.eq('preparation.map.mapKey', mapKey)
		)
		.first();
	if (receipt && receipt.companyId !== owner.companyId)
		throw new Error('Discussion map preparation ownership is invalid.');
	return Boolean(receipt);
}

/** A released map may have lost any drained prefix after its first marker. Start
 * the ordered fold again when reacquiring that marker; never adopt its old cursor. */
export async function acquireDiscussionMap(
	ctx: MutationCtx,
	owner: DiscussionOwner,
	manifest: TransitionManifest,
	cursor = initialDiscussionMapCursor(manifest)
) {
	const first = await ctx.db
		.query('discussionTransitionMapChunks')
		.withIndex('by_mapKey_and_firstBefore', (q) => q.eq('mapKey', manifest.mapKey))
		.first();
	if (first && (first.companyId !== owner.companyId || first.contractId !== owner.contractId))
		throw new Error('Discussion map acquisition ownership is invalid.');
	if (first?.garbage) {
		await ctx.db.patch('discussionTransitionMapChunks', first._id, { garbage: undefined });
		return initialDiscussionMapCursor(manifest);
	}
	return !first && cursor.splice ? initialDiscussionMapCursor(manifest) : { ...cursor };
}

/** Both construction paths share deterministic chunk boundaries and exact upsert.
 * Garbage is mutable lifecycle metadata, never part of immutable geometry. */
export async function stageDiscussionMapChunk(ctx: MutationCtx, row: MapChunk) {
	if (getConvexSize(row) > 4096 || !row.splices.length)
		throw new Error('A discussion map chunk exceeds its storage envelope.');
	const previous = await ctx.db
		.query('discussionTransitionMapChunks')
		.withIndex('by_mapKey_and_firstBefore', (q) =>
			q.eq('mapKey', row.mapKey).eq('firstBefore', row.firstBefore)
		)
		.unique();
	if (previous) {
		const { _id, _creationTime: _creationTime, garbage, ...stored } = previous;
		if (canonicalJson(stored) !== canonicalJson(row))
			throw new Error('Staged discussion map identity changed.');
		if (garbage) await ctx.db.patch('discussionTransitionMapChunks', _id, { garbage: undefined });
	} else await ctx.db.insert('discussionTransitionMapChunks', row);
}

/** Preparation streams at most ten final 4-KiB records, with cursor and receipt
 * continuation committed by the caller in the same transaction. Retrying an old
 * cursor verifies the immutable chunk instead of appending duplicate geometry. */
export async function stageDiscussionMap(
	ctx: MutationCtx,
	owner: DiscussionOwner,
	map: DiscussionMap,
	manifest: TransitionManifest,
	cursor?: MapBuildCursor
) {
	if (manifest.inline)
		return { done: true, manifest, cursor: cursor ?? initialDiscussionMapCursor(manifest) };
	await admitDiscussionWork(ctx, { reads: 2, queries: 2, writes: 1, bytes: 4096 });
	let progress = await acquireDiscussionMap(ctx, owner, manifest, cursor);
	for (let batch = 0; batch < 10 && progress.splice < map.splices.length; batch++) {
		try {
			await admitDiscussionWork(ctx, { reads: 1, queries: 1, writes: 1, bytes: 4096 });
		} catch (error) {
			if (error instanceof DiscussionPreparationRequired) break;
			throw error;
		}
		const splices = map.splices.slice(
			progress.splice,
			progress.splice + DISCUSSION_MAP_CHUNK_SPLICES
		);
		const base = {
			...owner,
			mapKey: manifest.mapKey,
			firstBefore: map.splices[progress.splice].beforeStart,
			startingDisplacement: progress.displacement
		};
		const row = { ...base, splices };
		await stageDiscussionMapChunk(ctx, row);
		const last = splices.at(-1)!;
		progress = {
			splice: progress.splice + splices.length,
			chunkCount: progress.chunkCount + 1,
			bytes: progress.bytes + getConvexSize(row),
			displacement: last.afterEnd - last.beforeEnd,
			hash: discussionMapChunkHash(progress.hash, progress.chunkCount, row)
		};
	}
	const done = progress.splice === map.splices.length;
	const staged = { ...manifest, chunkCount: progress.chunkCount, bytes: progress.bytes };
	if (done && !sealedDiscussionMap(staged, progress))
		throw new Error('Staged discussion map seal is incomplete.');
	return {
		done,
		cursor: progress,
		manifest: done ? staged : manifest
	};
}

/** First chunk owns bounded garbage drainage after the event/receipt releases the map. */
export async function retireDiscussionMap(
	ctx: MutationCtx,
	owner: DiscussionOwner,
	manifest: TransitionManifest
) {
	if (manifest.inline) return;
	if (await discussionMapOwned(ctx, owner, manifest.mapKey)) return;
	const first = await ctx.db
		.query('discussionTransitionMapChunks')
		.withIndex('by_mapKey_and_firstBefore', (q) => q.eq('mapKey', manifest.mapKey))
		.first();
	if (!first) return;
	if (first.companyId !== owner.companyId || first.contractId !== owner.contractId)
		throw new Error('Retired discussion map ownership is invalid.');
	await ctx.db.patch('discussionTransitionMapChunks', first._id, { garbage: true });
}

/** Per-request cache shares predecessor chunks across every thread on a native page. */
export class DiscussionMapReader {
	private readonly chunks = new Map<string, Promise<Doc<'discussionTransitionMapChunks'> | null>>();
	private readonly known = new Map<string, Map<number, Doc<'discussionTransitionMapChunks'>>>();
	constructor(
		private readonly ctx: QueryCtx,
		private readonly owner: DiscussionOwner,
		private readonly admitRead?: () => Promise<void>
	) {}
	private owned(row: Doc<'discussionTransitionMapChunks'> | null, manifest: TransitionManifest) {
		if (
			row &&
			(row.companyId !== this.owner.companyId ||
				row.contractId !== this.owner.contractId ||
				row.mapKey !== manifest.mapKey ||
				!row.splices.length ||
				row.splices[0].beforeStart !== row.firstBefore)
		)
			throw new Error('Discussion map chunk ownership or geometry is invalid.');
		if (row) {
			let before = row.firstBefore,
				after = row.firstBefore + row.startingDisplacement;
			for (const splice of row.splices) {
				if (
					splice.beforeStart < before ||
					splice.afterStart < after ||
					splice.beforeEnd < splice.beforeStart ||
					splice.afterEnd < splice.afterStart ||
					splice.beforeStart - before !== splice.afterStart - after ||
					splice.beforeEnd > manifest.beforeLength ||
					splice.afterEnd > manifest.afterLength
				)
					throw new Error('Discussion map chunk geometry is invalid.');
				before = splice.beforeEnd;
				after = splice.afterEnd;
			}
			const known = this.known.get(manifest.mapKey) ?? new Map();
			known.set(row.firstBefore, row);
			this.known.set(manifest.mapKey, known);
		}
		return row;
	}
	private predecessor(manifest: TransitionManifest, coordinate: number, inclusive: boolean) {
		for (const row of this.known.get(manifest.mapKey)?.values() ?? []) {
			if (
				(inclusive ? coordinate >= row.firstBefore : coordinate > row.firstBefore) &&
				coordinate <= row.splices.at(-1)!.beforeStart
			)
				return Promise.resolve(row);
		}
		const key = `${manifest.mapKey}:${coordinate}:${inclusive}`;
		let chunk = this.chunks.get(key);
		if (!chunk) {
			chunk = (async () => {
				await this.admitRead?.();
				const row = await this.ctx.db
					.query('discussionTransitionMapChunks')
					.withIndex('by_mapKey_and_firstBefore', (q) =>
						inclusive
							? q.eq('mapKey', manifest.mapKey).lte('firstBefore', coordinate)
							: q.eq('mapKey', manifest.mapKey).lt('firstBefore', coordinate)
					)
					.order('desc')
					.first();
				return this.owned(row, manifest);
			})();
			this.chunks.set(key, chunk);
		}
		return chunk;
	}
	async passage(
		interval: PassageInterval,
		manifest: TransitionManifest
	): Promise<PassageInterval | null> {
		if (!(
			interval.start >= 0 &&
			interval.end > interval.start &&
			interval.end <= manifest.beforeLength
		))
			return null;
		if (manifest.inline)
			return mapPassage(interval, {
				beforeLength: manifest.beforeLength,
				afterLength: manifest.afterLength,
				splices: manifest.inline
			});
		if (manifest.chunkCount <= 0) throw new Error('Discussion map is not sealed.');
		const first = await this.predecessor(manifest, interval.start, true);
		const last = await this.predecessor(manifest, interval.end, false);
		const splice = last?.splices.findLast((row) => row.beforeStart < interval.end);
		if (splice && splice.beforeEnd > interval.start) return null;
		if (splice && splice.beforeStart === splice.beforeEnd && splice.beforeStart > interval.start)
			return null;
		const preceding = first?.splices.findLast(
			(row) => row.beforeEnd <= interval.start && row.beforeStart <= interval.start
		);
		const displacement = preceding
			? preceding.afterEnd - preceding.beforeEnd
			: (first?.startingDisplacement ?? 0);
		return { start: interval.start + displacement, end: interval.end + displacement };
	}
	/** Seek to a bounded frame's start; continuations never replay prior map chunks. */
	async gapCursor(manifest: TransitionManifest, coordinate: number): Promise<MapGapCursor> {
		if (coordinate < 0 || coordinate > manifest.beforeLength)
			throw new Error('Invalid discussion gap cursor.');
		if (!manifest.inline && manifest.chunkCount <= 0)
			throw new Error('Discussion map is not sealed.');
		const chunk = manifest.inline ? null : await this.predecessor(manifest, coordinate, true);
		const splices = manifest.inline ?? chunk?.splices ?? [];
		const previous = splices.findLastIndex((row) => row.beforeStart <= coordinate);
		const splice = splices[previous];
		return {
			chunk: chunk?.firstBefore ?? null,
			splice: previous + 1,
			before: splice ? Math.max(coordinate, splice.beforeEnd) : coordinate,
			after: splice ? splice.afterEnd + Math.max(0, coordinate - splice.beforeEnd) : coordinate,
			done: coordinate === manifest.beforeLength
		};
	}
	async gapStep(
		manifest: TransitionManifest,
		cursor: MapGapCursor
	): Promise<{ cursor: MapGapCursor; gap: SurvivingGap | null }> {
		if (cursor.done) return { cursor, gap: null };
		let chunk: Doc<'discussionTransitionMapChunks'> | null = null;
		let splice = cursor.splice;
		if (!manifest.inline) {
			if (cursor.chunk !== null) {
				chunk = await this.predecessor(manifest, cursor.chunk, true);
				if (!chunk || chunk.firstBefore !== cursor.chunk)
					throw new Error('Discussion gap cursor lost its chunk.');
			}
			if (!chunk || splice >= chunk.splices.length) {
				await this.admitRead?.();
				const coordinate = chunk?.firstBefore;
				chunk = this.owned(
					await this.ctx.db
						.query('discussionTransitionMapChunks')
						.withIndex('by_mapKey_and_firstBefore', (q) =>
							coordinate === undefined
								? q.eq('mapKey', manifest.mapKey)
								: q.eq('mapKey', manifest.mapKey).gt('firstBefore', coordinate)
						)
						.first(),
					manifest
				);
				splice = 0;
			}
		}
		const next = (manifest.inline ?? chunk?.splices ?? [])[splice];
		if (next && next.beforeStart < cursor.before)
			throw new Error('Discussion gap cursor moved backwards.');
		const end = next?.beforeStart ?? manifest.beforeLength;
		const gap =
			end > cursor.before
				? {
						start: cursor.before,
						end,
						currentStart: cursor.after,
						currentEnd: cursor.after + end - cursor.before
					}
				: null;
		return {
			gap,
			cursor: next
				? {
						chunk: chunk?.firstBefore ?? null,
						splice: splice + 1,
						before: next.beforeEnd,
						after: next.afterEnd,
						done: false
					}
				: { ...cursor, before: manifest.beforeLength, after: manifest.afterLength, done: true }
		};
	}
	/** A bounded caller persists its last splice/gap cursor; no full map load. */
	async *gaps(manifest: TransitionManifest): AsyncGenerator<SurvivingGap> {
		if (manifest.inline) {
			yield* unchangedGaps({
				beforeLength: manifest.beforeLength,
				afterLength: manifest.afterLength,
				splices: manifest.inline
			});
			return;
		}
		if (manifest.chunkCount <= 0) throw new Error('Discussion map is not sealed.');
		let coordinate: number | null = null,
			before = 0,
			after = 0,
			count = 0;
		while (true) {
			await this.admitRead?.();
			const next: Doc<'discussionTransitionMapChunks'> | null = await this.ctx.db
				.query('discussionTransitionMapChunks')
				.withIndex('by_mapKey_and_firstBefore', (q) =>
					coordinate === null
						? q.eq('mapKey', manifest.mapKey)
						: q.eq('mapKey', manifest.mapKey).gt('firstBefore', coordinate)
				)
				.first();
			if (!next) break;
			this.owned(next, manifest);
			if (next.startingDisplacement !== after - before)
				throw new Error('Discussion map chunk displacement is invalid.');
			for (const splice of next.splices) {
				if (splice.beforeStart > before)
					yield {
						start: before,
						end: splice.beforeStart,
						currentStart: after,
						currentEnd: splice.afterStart
					};
				before = splice.beforeEnd;
				after = splice.afterEnd;
			}
			coordinate = next.firstBefore;
			count++;
		}
		if (count !== manifest.chunkCount) throw new Error('Discussion map chunks are incomplete.');
		if (manifest.beforeLength > before)
			yield {
				start: before,
				end: manifest.beforeLength,
				currentStart: after,
				currentEnd: manifest.afterLength
			};
	}
}
