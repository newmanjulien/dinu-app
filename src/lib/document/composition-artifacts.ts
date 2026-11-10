import type { SourceBlock, ResolvedBlock, ResolvedRun } from './model';

export interface CompositionArtifact<T extends object> {
	readonly id: number;
	readonly value: T;
}
interface Entry extends CompositionArtifact<object> {
	readonly key: string;
	readonly dependencies: readonly Entry[];
	references: number;
}

/** Working references belong to one request and are always released on completion or cancellation. */
export interface CompositionRequest {
	readonly owner: CompositionArtifactStore | undefined;
	getRuns(key: string): CompositionArtifact<ResolvedRun[]> | undefined;
	putRuns(
		key: string,
		value: ResolvedRun[],
		dependencies?: readonly CompositionArtifact<object>[]
	): CompositionArtifact<ResolvedRun[]>;
	getBlock(key: string): CompositionArtifact<ResolvedBlock> | undefined;
	putBlock(
		key: string,
		value: ResolvedBlock,
		dependencies?: readonly CompositionArtifact<object>[]
	): CompositionArtifact<ResolvedBlock>;
	release(): void;
}

type ArtifactValues = { runs: ResolvedRun[]; block: ResolvedBlock };
const familyKey = (family: keyof ArtifactValues, key: string) => JSON.stringify([family, key]);

/** Source-owned completed artifacts. The index owns only current, optional, or working
 * roots and their dependencies; cursors never keep an independent content cache.
 */
export class CompositionArtifactStore {
	readonly capacity = 256;
	#current = new Map<string, Entry>();
	#protected = new Set<Entry>();
	#optional = new Map<string, Entry>();
	#entries = new Map<string, Entry>();
	#values = new WeakMap<object, Entry>();
	#source?: readonly SourceBlock[];
	#nextId = 0;
	#destroyed = false;

	useSource(blocks: readonly SourceBlock[]) {
		this.#check();
		if (this.#source && this.#source !== blocks)
			throw new Error('Rendering artifacts belong to a different source.');
		this.#source = blocks;
	}
	#check() {
		if (this.#destroyed) throw new Error('Composition source released.');
	}
	#find(key: string): Entry | undefined {
		this.#check();
		const entry = this.#current.get(key) ?? this.#optional.get(key) ?? this.#entries.get(key);
		if (entry && this.#optional.get(key) === entry) {
			this.#optional.delete(key);
			this.#optional.set(key, entry);
		}
		return entry;
	}
	#entry(key: string, value: object, dependencies: readonly Entry[]): Entry {
		const entry = {
			key,
			value,
			id: ++this.#nextId,
			dependencies: [...new Set(dependencies)],
			references: 0
		};
		this.#values.set(value, entry);
		return entry;
	}
	#hold(entry: Entry) {
		const pending = [entry];
		while (pending.length) {
			const next = pending.pop()!;
			if (next.references++ !== 0) continue;
			this.#entries.set(next.key, next);
			pending.push(...next.dependencies);
		}
	}
	#release(entry: Entry) {
		const pending = [entry];
		while (pending.length) {
			const next = pending.pop()!;
			if (--next.references !== 0) continue;
			if (this.#entries.get(next.key) === next) this.#entries.delete(next.key);
			pending.push(...next.dependencies);
		}
	}
	#optionalize(entry: Entry, held = false) {
		if (this.#protected.has(entry)) {
			if (held) this.#release(entry);
			return;
		}
		const previous = this.#optional.get(entry.key);
		this.#optional.delete(entry.key);
		if (previous && (previous !== entry || held)) this.#release(previous);
		if (!held && previous !== entry) this.#hold(entry);
		this.#optional.set(entry.key, entry);
	}
	#trim() {
		while (this.#optional.size > this.capacity) {
			const key = this.#optional.keys().next().value!;
			const entry = this.#optional.get(key)!;
			this.#optional.delete(key);
			this.#release(entry);
		}
	}
	createRequest(): CompositionRequest {
		this.#check();
		const working = new Set<Entry>();
		let released = false;
		const pin = (entry: Entry) => {
			this.#check();
			if (released) throw new Error('Composition request released.');
			if (!working.has(entry)) {
				working.add(entry);
				this.#hold(entry);
			}
		};
		// Only fixed public methods reach these helpers. The family is part of every key,
		// so a hit was written with the same value type, including first-wins interning.
		const get = <Family extends keyof ArtifactValues>(family: Family, key: string) => {
			const entry = this.#find(familyKey(family, key));
			if (entry) pin(entry);
			return entry as CompositionArtifact<ArtifactValues[Family]> | undefined;
		};
		const put = <Family extends keyof ArtifactValues>(
			family: Family,
			key: string,
			value: ArtifactValues[Family],
			dependencies: readonly CompositionArtifact<object>[] = []
		) => {
			const storedKey = familyKey(family, key);
			const entry =
				this.#find(storedKey) ??
				this.#entry(
					storedKey,
					value,
					dependencies.map((dependency) => {
						const stored = this.#values.get(dependency.value);
						if (!stored) throw new Error('Composition dependency belongs to a different request.');
						return stored;
					})
				);
			pin(entry);
			this.#optionalize(entry);
			this.#trim();
			return entry as CompositionArtifact<ArtifactValues[Family]>;
		};
		return {
			owner: this,
			getRuns: (key) => get('runs', key),
			putRuns: (key, value, dependencies) => put('runs', key, value, dependencies),
			getBlock: (key) => get('block', key),
			putBlock: (key, value, dependencies) => put('block', key, value, dependencies),
			release: () => {
				if (released) return;
				released = true;
				for (const entry of working) this.#release(entry);
				working.clear();
			}
		};
	}
	retain(blocks: readonly ResolvedBlock[]) {
		this.#check();
		const current = new Map<string, Entry>();
		for (const block of blocks) {
			const entry = this.#values.get(block);
			if (!entry || current.has(entry.key)) continue;
			current.set(entry.key, entry);
			if (this.#current.get(entry.key) === entry) continue;
			if (this.#optional.get(entry.key) === entry) this.#optional.delete(entry.key);
			else this.#hold(entry);
		}
		const previous = this.#current;
		this.#current = current;
		const protectedEntries = new Set<Entry>();
		const pending = [...current.values()];
		while (pending.length) {
			const entry = pending.pop()!;
			if (protectedEntries.has(entry)) continue;
			protectedEntries.add(entry);
			pending.push(...entry.dependencies);
		}
		this.#protected = protectedEntries;
		for (const entry of protectedEntries) {
			if (this.#optional.get(entry.key) !== entry) continue;
			this.#optional.delete(entry.key);
			this.#release(entry);
		}
		for (const entry of previous.values())
			if (current.get(entry.key) !== entry) this.#optionalize(entry, true);
		this.#trim();
	}
	destroy() {
		if (this.#destroyed) return;
		this.#destroyed = true;
		const roots = [...this.#current.values(), ...this.#optional.values()];
		this.#current.clear();
		this.#optional.clear();
		this.#protected.clear();
		for (const entry of roots) this.#release(entry);
	}
}

/** Standalone synchronous consumers cache only within their current composition. */
export function createCompositionRequest(store?: CompositionArtifactStore): CompositionRequest {
	if (store) return store.createRequest();
	const entries = new Map<string, CompositionArtifact<object>>();
	let nextId = 0;
	// Family-qualified keys enforce the same invariant as the source-owned store.
	const get = <Family extends keyof ArtifactValues>(family: Family, key: string) =>
		entries.get(familyKey(family, key)) as CompositionArtifact<ArtifactValues[Family]> | undefined;
	const put = <Family extends keyof ArtifactValues>(
		family: Family,
		key: string,
		value: ArtifactValues[Family]
	) => {
		const storedKey = familyKey(family, key);
		const entry = entries.get(storedKey) ?? { id: ++nextId, value };
		entries.set(storedKey, entry);
		return entry as CompositionArtifact<ArtifactValues[Family]>;
	};
	return {
		owner: undefined,
		getRuns: (key) => get('runs', key),
		putRuns: (key, value) => put('runs', key, value),
		getBlock: (key) => get('block', key),
		putBlock: (key, value) => put('block', key, value),
		release: () => entries.clear()
	};
}
