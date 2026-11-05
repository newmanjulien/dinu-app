import type { ContractBlock, ResolvedBlock } from './model';

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
	get<T extends object>(key: string): CompositionArtifact<T> | undefined;
	put<T extends object>(
		key: string,
		value: T,
		dependencies?: readonly CompositionArtifact<object>[]
	): CompositionArtifact<T>;
	release(): void;
}

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
	#source?: readonly ContractBlock[];
	#nextId = 0;
	#destroyed = false;

	useSource(blocks: readonly ContractBlock[]) {
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
		return {
			owner: this,
			get: <T extends object>(key: string) => {
				const entry = this.#find(key);
				if (entry) pin(entry);
				return entry as CompositionArtifact<T> | undefined;
			},
			put: <T extends object>(
				key: string,
				value: T,
				dependencies: readonly CompositionArtifact<object>[] = []
			) => {
				const entry =
					this.#find(key) ??
					this.#entry(
						key,
						value,
						dependencies.map((dependency) => {
							const stored = this.#values.get(dependency.value);
							if (!stored)
								throw new Error('Composition dependency belongs to a different request.');
							return stored;
						})
					);
				pin(entry);
				this.#optionalize(entry);
				this.#trim();
				return entry as unknown as CompositionArtifact<T>;
			},
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
	get optionalSize() {
		return this.#optional.size;
	}
}

/** Standalone synchronous consumers cache only within their current composition. */
export function createCompositionRequest(store?: CompositionArtifactStore): CompositionRequest {
	if (store) return store.createRequest();
	const entries = new Map<string, CompositionArtifact<object>>();
	let nextId = 0;
	return {
		owner: undefined,
		get: <T extends object>(key: string) => entries.get(key) as CompositionArtifact<T> | undefined,
		put: <T extends object>(key: string, value: T) => {
			const entry = entries.get(key) ?? { id: ++nextId, value };
			entries.set(key, entry);
			return entry as unknown as CompositionArtifact<T>;
		},
		release: () => entries.clear()
	};
}
