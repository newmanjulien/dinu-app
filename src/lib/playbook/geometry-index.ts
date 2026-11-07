import type { ValidationSourceFacts } from '../contract/validation-source';
import type { ReplacementAtom } from '../contract/source-model';
import { targetContainers } from '../contract/ranges';
import { pointPosition } from '../contract/source-index';
import { isTextTarget } from '../contract/source-model';
import {
	changeCrossesBoundaryTrigger,
	changeTriggerOwner,
	playbookGeometryKey,
	triggersIntersect,
	validateTriggerRange
} from './geometry';
import type { ContractChange, PlaybookItem, SourceTarget, Trigger } from './model';
import {
	validateChangeGeometry,
	validateChangeReferences,
	validatePlaybookItemContent,
	validateStructuralReplacementContent,
	validateTriggers
} from './validation';
import { PlaybookValidationError } from './validation-error';

interface TriggerEntry {
	itemId: string;
	trigger: Trigger;
	containers: readonly string[];
}
interface ChangeEntry {
	itemId: string;
	change: ContractChange;
	containers: readonly string[];
}
interface ItemGeometry {
	item: PlaybookItem;
	triggers: TriggerEntry[];
	changes: ChangeEntry[];
	failures: unknown[];
}

/** Pure, bounded by the current Playbook. Buckets include cross-container Triggers. */
export class PlaybookGeometryIndex {
	readonly items = new Map<string, ItemGeometry>();
	readonly triggerIds = new Map<string, Set<TriggerEntry>>();
	readonly metrics = { queries: 0, candidatesVisited: 0, entriesInserted: 0, entriesRemoved: 0 };
	version = 0;
	private triggers = new Map<string, Set<TriggerEntry>>();
	private changes = new Map<string, Set<ChangeEntry>>();
	private failures = new Map<string, unknown>();
	private dirty = new Set<string>();
	private loadingCertified = false;
	private containers: { key: string; start: number; end: number }[];
	constructor(
		readonly contract: {
			index: ValidationSourceFacts;
			validateReference(ref: Extract<ReplacementAtom, { kind: 'reference' }>): void;
		}
	) {
		this.containers = [...contract.index.containers.values()]
			.map((container) => ({
				key: container.containerKey,
				start: container.units[0].position,
				end: container.units.at(-1)!.position + container.units.at(-1)!.length
			}))
			.sort((a, b) => a.start - b.start);
	}

	/** A certified unchanged snapshot needs buckets, not another audit of every relation. */
	loadCertified(items: Iterable<readonly [string, PlaybookItem]>) {
		if (this.items.size) throw new Error('Certified geometry requires an empty index');
		this.loadingCertified = true;
		try {
			for (const [id, item] of items) this.set(id, item);
		} finally {
			this.loadingCertified = false;
		}
		for (const { failures } of this.items.values()) if (failures.length) throw failures[0];
		this.dirty.clear();
		this.failures.clear();
	}

	/** Binary-search the first possible container; include both endpoints for point ownership. */
	private containersFor(target: SourceTarget): string[] {
		if (!isTextTarget(target))
			return targetContainers(this.contract.index, target).map(
				(container) => container.containerKey
			);
		const start = pointPosition(this.contract.index, target.range.start);
		const end = pointPosition(this.contract.index, target.range.end);
		if (start > end) throw new PlaybookValidationError('Source range is reversed');
		let low = 0,
			high = this.containers.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (this.containers[mid].end < start) low = mid + 1;
			else high = mid;
		}
		const result: string[] = [];
		for (let i = low; i < this.containers.length && this.containers[i].start <= end; i++)
			result.push(this.containers[i].key);
		return result;
	}

	private add<T>(buckets: Map<string, Set<T>>, key: string, entry: T) {
		let bucket = buckets.get(key);
		if (!bucket) buckets.set(key, (bucket = new Set()));
		bucket.add(entry);
	}

	private removeEntry<T>(buckets: Map<string, Set<T>>, key: string, entry: T) {
		const bucket = buckets.get(key);
		bucket?.delete(entry);
		if (!bucket?.size) buckets.delete(key);
	}

	/** Invalid imported entries retain diagnostics and remain replaceable by an editable draft. */
	set(itemId: string, item: PlaybookItem) {
		const compiled: ItemGeometry = { item, triggers: [], changes: [], failures: [] };
		const trigger = item.trigger;
		try {
			validateTriggerRange(this.contract.index, trigger.target);
			compiled.triggers.push({ itemId, trigger, containers: this.containersFor(trigger.target) });
		} catch (error) {
			compiled.failures.push(error);
		}
		for (const concession of item.concessions)
			for (const change of concession.changes) {
				try {
					targetContainers(this.contract.index, change.target);
					compiled.changes.push({
						itemId,
						change,
						containers: this.containersFor(change.target)
					});
				} catch (error) {
					compiled.failures.push(error);
				}
			}
		this.remove(itemId);
		this.items.set(itemId, compiled);
		for (const entry of compiled.triggers) {
			this.add(this.triggerIds, entry.trigger.id, entry);
			for (const key of entry.containers) this.add(this.triggers, key, entry);
		}
		for (const entry of compiled.changes)
			for (const key of entry.containers) this.add(this.changes, key, entry);
		if (!this.loadingCertified) {
			this.markAffected(compiled);
			this.dirty.add(itemId);
		}
		this.metrics.entriesInserted += compiled.triggers.length + compiled.changes.length;
		this.version++;
	}

	remove(itemId: string) {
		const previous = this.items.get(itemId);
		if (!previous) return;
		if (!this.loadingCertified) this.markAffected(previous);
		for (const entry of previous.triggers) {
			this.removeEntry(this.triggerIds, entry.trigger.id, entry);
			for (const key of entry.containers) this.removeEntry(this.triggers, key, entry);
		}
		for (const entry of previous.changes)
			for (const key of entry.containers) this.removeEntry(this.changes, key, entry);
		this.items.delete(itemId);
		this.failures.delete(itemId);
		this.dirty.delete(itemId);
		this.metrics.entriesRemoved += previous.triggers.length + previous.changes.length;
		this.version++;
	}

	private candidates<T extends { itemId: string }>(
		buckets: Map<string, Set<T>>,
		range: SourceTarget,
		exclude?: string
	): T[] {
		this.metrics.queries++;
		const candidates = new Set<T>();
		for (const key of this.containersFor(range))
			for (const entry of buckets.get(key) ?? [])
				if (entry.itemId !== exclude) candidates.add(entry);
		this.metrics.candidatesVisited += candidates.size;
		return [...candidates];
	}

	private triggerCandidates(range: SourceTarget, exclude?: string): Trigger[] {
		return this.candidates(this.triggers, range, exclude).map((entry) => entry.trigger);
	}

	triggersIntersecting(range: SourceTarget, exclude?: string): Trigger[] {
		return this.triggerCandidates(range, exclude).filter((trigger) =>
			triggersIntersect(this.contract.index, trigger.target, range)
		);
	}

	private ownerForChange(change: ContractChange, exclude?: string, draft: readonly Trigger[] = []) {
		return changeTriggerOwner(
			this.contract.index,
			[...this.triggerCandidates(change.target, exclude), ...draft],
			change
		);
	}

	/** Validate the proposed Trigger overlay, never a copied persisted Trigger universe. */
	validateTriggersReplacing(exclude: string | undefined, triggers: readonly Trigger[]) {
		this.refreshValidation();
		for (const [id, failure] of this.failures) {
			if (id === exclude) continue;
			if (exclude === undefined) throw failure;
			// A replacement can repair a relation involving the excluded saved item.
			this.validatePersistedGeometry(id, exclude);
		}
		validateTriggers(this.contract.index, triggers);
		for (const trigger of triggers) {
			if ([...(this.triggerIds.get(trigger.id) ?? [])].some((entry) => entry.itemId !== exclude))
				throw new PlaybookValidationError(`Duplicate Trigger ID: ${trigger.id}`);
			const other = this.triggersIntersecting(trigger.target, exclude)[0];
			if (other)
				throw new PlaybookValidationError(`Overlapping Triggers: ${other.id}, ${trigger.id}`);
		}
		this.validateOwnershipAfterTriggers(triggers, exclude);
	}

	/** Throws the original boundary/ambiguous-owner diagnostic for affected persisted changes. */
	private validateOwnershipAfterTriggers(triggers: readonly Trigger[], exclude?: string) {
		const affected = new Set(
			triggers.flatMap((trigger) => this.candidates(this.changes, trigger.target, exclude))
		);
		for (const entry of affected) {
			if (
				triggers.some(
					(trigger) =>
						triggersIntersect(this.contract.index, trigger.target, entry.change.target) ||
						changeCrossesBoundaryTrigger(this.contract.index, entry.change.target, trigger.target)
				)
			)
				this.ownerForChange(entry.change, exclude, triggers);
		}
	}

	validateChanges(
		changes: readonly ContractChange[],
		exclude?: string,
		draft: readonly Trigger[] = []
	) {
		// Item-local conflict order and diagnostic precedence stay in the canonical validator.
		const triggers = [
			...new Set(changes.flatMap((change) => this.triggerCandidates(change.target, exclude))),
			...draft
		];
		validateChangeGeometry(this.contract.index, triggers, changes);
	}

	/** Invalidate only relations sharing an old/new container or a global Trigger ID. */
	private markAffected(item: ItemGeometry) {
		for (const entry of item.triggers) {
			for (const other of this.triggerIds.get(entry.trigger.id) ?? []) this.dirty.add(other.itemId);
			for (const key of entry.containers) {
				for (const other of this.triggers.get(key) ?? []) this.dirty.add(other.itemId);
				for (const other of this.changes.get(key) ?? []) this.dirty.add(other.itemId);
			}
		}
	}

	private validatePersistedGeometry(id: string, exclude?: string) {
		const { item, failures } = this.items.get(id)!;
		if (failures.length) throw failures[0];
		validateTriggers(this.contract.index, [item.trigger]);
		const trigger = item.trigger;
		if (
			[...(this.triggerIds.get(trigger.id) ?? [])].some(
				(entry) => entry.itemId !== id && entry.itemId !== exclude
			)
		)
			throw new PlaybookValidationError(`Duplicate Trigger ID: ${trigger.id}`);
		const other = this.candidates(this.triggers, trigger.target, exclude).find(
			(entry) =>
				entry.itemId !== id &&
				triggersIntersect(this.contract.index, entry.trigger.target, trigger.target)
		);
		if (other)
			throw new PlaybookValidationError(`Overlapping Triggers: ${other.trigger.id}, ${trigger.id}`);
		for (const concession of item.concessions) this.validateChanges(concession.changes, exclude);
	}

	/** Coalesce a snapshot's edits before refreshing persisted relational diagnostics. */
	refreshValidation() {
		for (const id of this.dirty) {
			this.failures.delete(id);
			try {
				this.validatePersistedGeometry(id);
			} catch (error) {
				this.failures.set(id, error);
			}
		}
		this.dirty.clear();
	}

	/** Each item's geometry is audited once, without validating its neighbors again. */
	audit() {
		this.refreshValidation();
		for (const failure of this.failures.values()) throw failure;
		for (const { item } of this.items.values()) {
			validatePlaybookItemContent(item);
			validateStructuralReplacementContent(item);
			validateChangeReferences(this.contract, item);
		}
	}

	/** One draft's geometry memo, excluding business copy. No persisted universe is cached. */
	createDraftValidator() {
		let previous = '',
			failure: { diagnostic: unknown } | undefined;
		return (exclude: string | undefined, item: Parameters<typeof playbookGeometryKey>[0]) => {
			const key = JSON.stringify([this.version, exclude, playbookGeometryKey(item)]);
			if (key !== previous) {
				previous = key;
				failure = undefined;
				try {
					this.validateTriggersReplacing(exclude, [item.trigger]);
					for (const concession of item.concessions)
						this.validateChanges(concession.changes, exclude, [item.trigger]);
				} catch (diagnostic) {
					failure = { diagnostic };
				}
			}
			if (failure) throw failure.diagnostic;
		};
	}
}
