import type { PreparedBlock } from './prepare';
import {
	hasExactGeometry,
	type BlockLayoutProfile,
	type GeometryDetail,
	type LayoutProfiles
} from './profile';
import { LayoutProfileCache } from './profile-cache';
import { DocumentScheduler } from '../runtime/scheduler';

/** Request-local counters for foreground rendering and background preparation. */
export interface LayoutProfileMetrics {
	profileCacheHits: number;
	profileCacheMisses: number;
	profileUniqueMisses: number;
	profileBatchCount: number;
	profileDomUpdateMs: number;
	profileReadMs: number;
	profileTotalMs: number;
	/** Largest block's geometry-read time, summed across table passes. */
	maxProfileBlockMs: number;
	maxProfileTransactionMs: number;
	profileTransactionOverruns: number;
}

export interface LayoutProfileSurface {
	/** Undefined while fonts are loading or the surface is detached. Always read live. */
	readonly epoch: string | undefined;
	/** The visitor and any exact upgrade finish before the shared DOM is cleared. */
	withBlock<T>(
		block: PreparedBlock,
		expectedEpoch: string,
		detail: GeometryDetail,
		visit: (profile: BlockLayoutProfile, readExact: () => BlockLayoutProfile) => T,
		metrics?: LayoutProfileMetrics
	): T;
}

export class StaleLayoutProfileError extends Error {
	constructor() {
		super('Layout environment changed during profiling.');
		this.name = 'StaleLayoutProfileError';
	}
}

function validateAssociation(block: PreparedBlock, profile: BlockLayoutProfile): void {
	const fragment = block.fragment;
	if (
		profile.kind !== fragment.type ||
		(profile.kind === 'paragraph' &&
			fragment.type === 'paragraph' &&
			profile.tokenCount !== fragment.tokens.length) ||
		(profile.kind === 'table' &&
			fragment.type === 'table' &&
			(profile.headerRowCount !== fragment.headerRowCount ||
				profile.bodyRowHeights.length !== fragment.rows.length - fragment.headerRowCount ||
				fragment.rows.some((row) => row.length !== profile.columnWidths.length)))
	)
		throw new Error('Layout profile does not match its prepared block.');
}

function strongestGeometry(associations: Iterable<readonly [PreparedBlock, BlockLayoutProfile]>) {
	const geometry = new Map<string, BlockLayoutProfile>();
	for (const [block, profile] of associations) {
		const existing = geometry.get(block.geometryFingerprint);
		if (!existing || (!hasExactGeometry(existing) && hasExactGeometry(profile)))
			geometry.set(block.geometryFingerprint, profile);
	}
	return geometry;
}

/** Serializes shared-surface requests; deduplicates geometry before any DOM work.
 * Returned associations always use the current request's prepared objects, never cached content.
 */
export class LayoutProfiler {
	#alternatives = new Set<AbortController>();
	#retained?: { owner: symbol; epoch: string };

	constructor(
		readonly surface: LayoutProfileSurface,
		readonly cache = new LayoutProfileCache(),
		readonly scheduler = new DocumentScheduler()
	) {}

	get epoch(): string | undefined {
		return this.surface.epoch;
	}

	beginPreparation() {
		for (const abort of this.#alternatives) abort.abort();
		this.#alternatives.clear();
	}

	trackAlternative(abort: AbortController) {
		this.#alternatives.add(abort);
		return () => this.#alternatives.delete(abort);
	}

	/** Synchronous single-block transactions; all geometry also stays request-local. */
	createRequest(
		epoch: string,
		metrics?: LayoutProfileMetrics,
		initial?: LayoutProfiles,
		checkCurrent: () => void = () => {}
	) {
		const profiles = new Map<PreparedBlock, BlockLayoutProfile>(initial);
		const geometry = strongestGeometry(profiles);
		const store = (block: PreparedBlock, profile: BlockLayoutProfile) => {
			checkCurrent();
			if (this.epoch !== epoch) throw new StaleLayoutProfileError();
			validateAssociation(block, profile);
			const stored = this.cache
				.setBatch(epoch, new Map([[block.geometryFingerprint, profile]]))
				.get(block.geometryFingerprint)!;
			geometry.set(block.geometryFingerprint, stored);
			profiles.set(block, stored);
		};
		const resolve = <T>(
			block: PreparedBlock,
			detail: GeometryDetail = 'exact',
			advance?: (upgrade: () => void) => T
		): T | undefined => {
			checkCurrent();
			if (this.epoch !== epoch) throw new StaleLayoutProfileError();
			this.cache.useEpoch(epoch);
			const key = block.geometryFingerprint;
			const local = geometry.get(key);
			const cached = this.cache.get(epoch, key);
			const profile = cached && hasExactGeometry(cached) ? cached : (local ?? cached);
			if (profile && (detail === 'bounds' || hasExactGeometry(profile))) {
				if (metrics) metrics.profileCacheHits++;
				validateAssociation(block, profile);
				geometry.set(key, profile);
				profiles.set(block, profile);
				return advance?.(() => {
					resolve(block, 'exact');
				});
			}
			if (metrics) {
				metrics.profileCacheMisses++;
				metrics.profileUniqueMisses++;
				metrics.profileBatchCount++;
			}
			const started = metrics ? performance.now() : 0;
			try {
				return this.surface.withBlock(
					block,
					epoch,
					detail,
					(measured, readExact) => {
						store(block, measured);
						return advance?.(() => store(block, readExact()));
					},
					metrics
				);
			} finally {
				if (metrics) {
					const elapsed = performance.now() - started;
					metrics.profileTotalMs += elapsed;
					metrics.maxProfileTransactionMs = Math.max(metrics.maxProfileTransactionMs, elapsed);
					if (elapsed > 4) metrics.profileTransactionOverruns++;
				}
			}
		};
		return { profiles, resolve };
	}

	retain(blocks: readonly PreparedBlock[], profiles: LayoutProfiles, epoch: string, owner: symbol) {
		if (this.epoch !== epoch || (this.#retained?.owner === owner && this.#retained.epoch === epoch))
			return;
		this.cache.useEpoch(epoch);
		this.cache.retain(
			epoch,
			strongestGeometry(blocks.map((block) => [block, profiles.get(block)!] as const))
		);
		this.#retained = { owner, epoch };
	}
	release(owner: symbol) {
		if (this.#retained?.owner !== owner) return;
		this.cache.release(this.#retained.epoch);
		this.#retained = undefined;
	}
}
