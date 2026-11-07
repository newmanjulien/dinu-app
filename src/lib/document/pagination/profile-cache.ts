import { hasExactGeometry, validateBlockLayoutProfile, type BlockLayoutProfile } from './profile';

/** Current-document geometry plus a bounded LRU of other shapes, all for one epoch. */
export class LayoutProfileCache {
	#epoch: string | undefined;
	#active = new Map<string, BlockLayoutProfile>();
	#profiles = new Map<string, BlockLayoutProfile>();

	constructor(readonly capacity = 256) {
		if (!Number.isSafeInteger(capacity) || capacity < 1)
			throw new RangeError('Layout profile cache capacity must be a positive integer.');
	}

	useEpoch(epoch: string): void {
		if (this.#epoch === epoch) return;
		this.#epoch = epoch;
		this.#active.clear();
		this.#profiles.clear();
	}

	get availableWarmSlots(): number {
		return this.capacity - this.#profiles.size;
	}

	/** Keep every current shape, even when the document exceeds the optional LRU capacity. */
	retain(epoch: string, profiles: ReadonlyMap<string, BlockLayoutProfile>): void {
		if (epoch !== this.#epoch) throw new Error('Cannot retain stale layout profiles.');
		const previous = this.#active;
		this.#active = new Map(
			[...profiles].map(([key, profile]) => {
				const cached = previous.get(key) ?? this.#profiles.get(key);
				return [key, cached && hasExactGeometry(cached) ? cached : profile];
			})
		);
		for (const key of profiles.keys()) this.#profiles.delete(key);
		for (const [key, profile] of previous) if (!profiles.has(key)) this.#store(key, profile);
	}

	get(epoch: string, fingerprint: string): BlockLayoutProfile | undefined {
		if (epoch !== this.#epoch) return;
		const active = this.#active.get(fingerprint);
		if (active) return active;
		const profile = this.#profiles.get(fingerprint);
		if (profile) {
			this.#profiles.delete(fingerprint);
			this.#profiles.set(fingerprint, profile);
		}
		return profile;
	}
	/** An evicted document's geometry becomes subject to the ordinary LRU capacity. */
	release(epoch: string): void {
		if (epoch !== this.#epoch) return;
		const previous = this.#active;
		this.#active = new Map();
		for (const [key, profile] of previous) this.#store(key, profile);
	}

	/** Normalize and validate the complete batch before inserting any entry. */
	setBatch(
		epoch: string,
		profiles: ReadonlyMap<string, BlockLayoutProfile>
	): ReadonlyMap<string, BlockLayoutProfile> {
		if (epoch !== this.#epoch) throw new Error('Cannot cache a stale layout profile.');
		const stored = new Map(
			[...profiles].map(
				([fingerprint, profile]) => [fingerprint, normalizeProfile(profile)] as const
			)
		);
		for (const [fingerprint, profile] of stored) {
			const existing = this.get(epoch, fingerprint);
			const preferred = existing && hasExactGeometry(existing) ? existing : profile;
			stored.set(fingerprint, preferred);
			if (this.#active.has(fingerprint)) this.#active.set(fingerprint, preferred);
			else this.#store(fingerprint, preferred);
		}
		return stored;
	}

	#store(fingerprint: string, profile: BlockLayoutProfile): void {
		this.#profiles.delete(fingerprint);
		this.#profiles.set(fingerprint, profile);
		if (this.#profiles.size > this.capacity)
			this.#profiles.delete(this.#profiles.keys().next().value!);
	}
}

function normalizeProfile(profile: BlockLayoutProfile): BlockLayoutProfile {
	validateBlockLayoutProfile(profile);
	// Copy only geometry fields and freeze nested arrays: neither caller mutation nor
	// extra properties on a surface result may carry content/provenance into the cache.
	return Object.freeze(
		profile.kind === 'paragraph'
			? {
					kind: 'paragraph',
					tokenCount: profile.tokenCount,
					marginBlockStart: profile.marginBlockStart,
					marginBlockEnd: profile.marginBlockEnd,
					contentHeight: profile.contentHeight,
					lines:
						profile.lines &&
						Object.freeze(
							profile.lines.map(({ startToken, endToken, top, bottom }) =>
								Object.freeze({ startToken, endToken, top, bottom })
							)
						)
				}
			: {
					kind: 'table',
					columnWidths: Object.freeze([...profile.columnWidths]),
					marginBlockStart: profile.marginBlockStart,
					marginBlockEnd: profile.marginBlockEnd,
					headerRowCount: profile.headerRowCount,
					headerHeight: profile.headerHeight,
					bodyRowHeights: Object.freeze([...profile.bodyRowHeights]),
					borderBlockStart: profile.borderBlockStart,
					borderBlockEnd: profile.borderBlockEnd
				}
	);
}
