import type { ConcessionSelection } from '../playbook/model';
import type { ContractBlock, ContractView, ResolvedBlock, ResolvedRun } from './model';
import type { Trigger, ContractChange, SourceRange } from '../playbook/model';
import type { InlineSource, ReplacementAtom } from './source-model';
import {
	triggerAnnotationId,
	type AnnotationMembership,
	type DocumentOverlayItem
} from '../playbook/document-overlay';
import { activatedBlock, changeTriggerOwner } from '../playbook/geometry';
import {
	buildSourceIndex,
	iterateSourceIndex,
	iterateSourceAddresses,
	type SourceIndex,
	pointPosition,
	type SourceContainer
} from './source-index';
import { localContainer, rangeText, unitsInRange } from './ranges';
import { diffRedlineText } from './redline-diff';
import { referenceText, type Address } from './numbering';
import { createChangeConflictChecker } from '../playbook/conflicts';

type OwnedTrigger = Trigger & { itemId: string };
type PositionedAnnotation = AnnotationMembership & { start: number; end: number };
type ChangeOrigin = {
	change: ContractChange;
	origin?: { itemId: string; concessionId: string; changeIndex: number };
	effect?: AnnotationMembership;
};
type Patch = ChangeOrigin & { start: number; end: number };
type Annotation = Pick<ResolvedRun, 'annotations' | 'visualSource' | 'generatedOffset'>;

function needsRedlineSeparator(deleted: string, inserted: string): boolean {
	const content = /[\p{L}\p{N}\p{M}\p{S}]/u;
	return (
		!/\s$/u.test(deleted) &&
		!/^\s/u.test(inserted) &&
		content.test(deleted) &&
		content.test(inserted)
	);
}

function emptyHitTarget(annotations: AnnotationMembership[]): ResolvedRun[] {
	return [
		{
			text: '\u00a0',
			generated: 'empty-hit-target',
			annotations,
			visualSource: annotations[0]?.range,
			generatedOffset: 0
		}
	];
}

export interface CompositionInput {
	items: readonly DocumentOverlayItem[];
	activeConcessions: ConcessionSelection;
	previewChanges?: readonly ContractChange[];
	view: ContractView;
}

/** The full and incremental entry points share all redline/provenance rules. */
export function composeContract(
	input: CompositionInput & { blocks: readonly ContractBlock[] }
): ResolvedBlock[] {
	return [...new ContractCompositionEngine(input.blocks).compose(input)];
}

/** Workspace-owned immutable source structure and resolved container/block versions. */
export class ContractCompositionEngine {
	#index?: SourceIndex;
	#initialized = false;
	#unfinishedBlocks = new Set<string>();
	#blocks: readonly ContractBlock[];
	#atomsByKey = new Map<string, InlineSource>();
	#items?: readonly DocumentOverlayItem[];
	#triggers: OwnedTrigger[] = [];
	#overlay = new WeakMap<
		DocumentOverlayItem,
		{ annotations: PositionedAnnotation[]; containers: Map<string, PositionedAnnotation[]> }
	>();
	#annotationVersions = new Map<string, string>();
	#dependencies = new Map<string, Set<string>>();
	#containers = new Map<string, { version: string; content: ResolvedRun[] }>();
	#trimmed = new WeakMap<ResolvedRun[], ResolvedRun[]>();
	#slots = new Map<string, { version: string; content: ResolvedRun[] }>();
	#resolved = new Map<string, ResolvedBlock>();
	#activeKey = '';
	#view?: ContractView;
	#patchVersions = new Map<string, string>();
	#activationVersions = new Map<string, string>();
	#dirtyContainers = new Set<string>();
	#current = new Map<string, Address>();
	recomposedBlocks = 0;
	affectedContainers = 0;
	constructor(blocks: readonly ContractBlock[], index?: SourceIndex) {
		this.#blocks = blocks;
		this.#index = index;
	}
	get index(): SourceIndex {
		return (this.#index ??= buildSourceIndex(this.#blocks));
	}
	*#initialize(): Generator<undefined> {
		if (this.#initialized) return;
		const index = this.#index ?? (yield* iterateSourceIndex(this.#blocks));
		const current = yield* iterateSourceAddresses(this.#blocks);
		const atoms = new Map<string, InlineSource>();
		for (const block of this.#blocks) {
			if (block.kind === 'table') {
				for (const row of block.rows)
					for (const cell of row) {
						for (const atom of cell.content) atoms.set(atom.sourceKey, atom);
						yield undefined;
					}
			} else for (const atom of block.content) atoms.set(atom.sourceKey, atom);
			yield undefined;
		}
		const dependencies = new Map<string, Set<string>>(),
			dirty = new Set<string>();
		for (const container of index.containers.values()) {
			const targets = new Set<string>();
			for (const unit of container.units) {
				if (unit.kind === 'number') targets.add(unit.sourceKey.slice('number:'.length));
				const atom = atoms.get(unit.sourceKey);
				if (atom?.kind === 'reference') {
					targets.add(atom.targetItemKey);
					if (atom.endTargetItemKey) targets.add(atom.endTargetItemKey);
				}
			}
			dependencies.set(container.containerKey, targets);
			dirty.add(container.containerKey);
			yield undefined;
		}
		this.#index = index;
		this.#current = current;
		this.#atomsByKey = atoms;
		this.#dependencies = dependencies;
		this.#dirtyContainers = dirty;
		this.#initialized = true;
	}
	/** Numbering accepted by the most recent composition, including optional paragraphs. */
	get addresses(): ReadonlyMap<string, Address> {
		return this.#current;
	}
	*compose(
		input: CompositionInput,
		options: { changedOnly?: boolean } = {}
	): Generator<ResolvedBlock> {
		for (const block of this.iterate(input, options)) if (block) yield block;
	}
	*iterate(
		{ items, activeConcessions, previewChanges = [], view }: CompositionInput,
		{ changedOnly = false }: { changedOnly?: boolean } = {}
	): Generator<ResolvedBlock | undefined> {
		yield* this.#initialize();
		const blocks = this.#blocks,
			index = this.index,
			atomsByKey = this.#atomsByKey;
		this.recomposedBlocks = 0;
		this.affectedContainers = 0;
		const changes: ChangeOrigin[] = [];
		for (const item of items) {
			const concession = item.concessions.find((c) => c.id === activeConcessions[item.itemId]);
			for (const [changeIndex, change] of (concession?.changes ?? []).entries()) {
				changes.push({
					change,
					origin: { itemId: item.itemId, concessionId: concession!.id, changeIndex },
					effect: item.annotations.find(
						(annotation) =>
							annotation.kind === 'concession-effect' &&
							annotation.concessionId === concession!.id &&
							annotation.changeIndex === changeIndex
					)
				});
				yield undefined;
			}
			yield undefined;
		}
		for (const change of previewChanges) {
			changes.push({ change });
			yield undefined;
		}
		const activations = new Map<string, ChangeOrigin>();
		for (const patch of changes) {
			const block = activatedBlock(index, patch.change);
			if (block) activations.set(block, patch);
			yield undefined;
		}
		// Construct and validate the entire candidate before changing accepted input state.
		const previousAddresses = this.#current;
		const activeKey = JSON.stringify([...activations.keys()].sort());
		const current =
			activeKey === this.#activeKey
				? previousAddresses
				: yield* iterateSourceAddresses(blocks, new Set(activations.keys()));
		const activationVersions = new Map<string, string>();
		for (const [key, change] of activations) {
			activationVersions.set(key, JSON.stringify(change));
			yield undefined;
		}
		const triggers = items === this.#items ? this.#triggers : [];
		if (items !== this.#items)
			for (const item of items) {
				for (const trigger of item.triggers) triggers.push({ ...trigger, itemId: item.itemId });
				yield undefined;
			}
		const overlays: {
			annotations: PositionedAnnotation[];
			containers: Map<string, PositionedAnnotation[]>;
		}[] = [];
		for (const item of items) {
			let cached = this.#overlay.get(item);
			if (!cached) {
				const annotations: PositionedAnnotation[] = [];
				for (const annotation of item.annotations) {
					annotations.push({
						...annotation,
						start: pointPosition(index, annotation.range.start),
						end: pointPosition(index, annotation.range.end)
					});
					yield undefined;
				}
				const containers = new Map<string, PositionedAnnotation[]>();
				for (const container of index.containers.values()) {
					const start = container.units[0].position,
						last = container.units.at(-1)!;
					const local = annotations.filter((annotation) =>
						annotation.start === annotation.end
							? index.byKey.get(annotation.range.start.sourceKey)?.containerKey ===
								container.containerKey
							: annotation.start < last.position + last.length && annotation.end > start
					);
					if (local.length) containers.set(container.containerKey, local);
					yield undefined;
				}
				cached = { annotations, containers };
				this.#overlay.set(item, cached);
			}
			overlays.push(cached);
			yield undefined;
		}
		const prioritized = new Map<string, PositionedAnnotation>();
		for (const overlay of overlays)
			for (const annotation of overlay.annotations) {
				prioritized.set(annotation.id, {
					...annotation,
					applied:
						annotation.kind === 'concession-effect' &&
						activeConcessions[annotation.itemId] === annotation.concessionId
				});
				yield undefined;
			}
		const annotationsByContainer = new Map<string, PositionedAnnotation[]>();
		for (const key of index.containers.keys()) {
			annotationsByContainer.set(key, []);
			yield undefined;
		}
		for (const overlay of overlays)
			for (const [key, annotations] of overlay.containers) {
				annotationsByContainer
					.get(key)!
					.push(...annotations.map((annotation) => prioritized.get(annotation.id)!));
				yield undefined;
			}
		const annotationVersions = new Map<string, string>();
		for (const [key, annotations] of annotationsByContainer) {
			annotationVersions.set(key, JSON.stringify(annotations));
			yield undefined;
		}
		const patches = new Map<string, Patch[]>();
		const conflicts = createChangeConflictChecker(index);
		for (const patch of changes) {
			const { change } = patch;
			const range = change.range;
			const key = localContainer(index, range);
			const items = patches.get(key) ?? [];
			if (items.some((patch) => conflicts(patch.change, change)))
				throw new Error(`Conflicting active changes in ${key}`);
			items.push({
				...patch,
				start: pointPosition(index, range.start),
				end: pointPosition(index, range.end)
			});
			patches.set(key, items);
			yield undefined;
		}
		const patchVersions = new Map<string, string>();
		for (const [key, value] of patches) {
			patchVersions.set(key, JSON.stringify(value));
			yield undefined;
		}
		const replacementDependencies = new Map<string, Set<string>>();
		for (const [key, localPatches] of patches) {
			const targets = new Set<string>();
			for (const patch of localPatches)
				for (const atom of patch.change.replacement) {
					if (atom.kind !== 'reference') continue;
					targets.add(atom.targetItemKey);
					if (atom.endTargetItemKey) targets.add(atom.endTargetItemKey);
				}
			replacementDependencies.set(key, targets);
			yield undefined;
		}
		const dirty = new Set<string>();
		if (this.#view !== view)
			for (const key of index.containers.keys()) {
				dirty.add(key);
				yield undefined;
			}
		for (const [next, previous] of [
			[activationVersions, this.#activationVersions],
			[annotationVersions, this.#annotationVersions],
			[patchVersions, this.#patchVersions]
		]) {
			for (const key of next.keys()) {
				if (next.get(key) !== previous.get(key)) dirty.add(key);
				yield undefined;
			}
			for (const key of previous.keys()) {
				if (!next.has(key)) dirty.add(key);
				yield undefined;
			}
		}
		if (previousAddresses !== current) {
			const changedTargets = new Set<string>();
			for (const key of current.keys()) {
				if (JSON.stringify(current.get(key)) !== JSON.stringify(previousAddresses.get(key)))
					changedTargets.add(key);
				yield undefined;
			}
			for (const key of previousAddresses.keys()) {
				if (!current.has(key)) changedTargets.add(key);
				yield undefined;
			}
			for (const [key, targets] of this.#dependencies) {
				if (
					[...targets, ...(replacementDependencies.get(key) ?? [])].some((target) =>
						changedTargets.has(target)
					)
				)
					dirty.add(key);
				yield undefined;
			}
		}
		// Install a complete candidate; unfinished blocks survive cancellation.
		for (const key of this.#dirtyContainers) {
			dirty.add(key);
			yield undefined;
		}
		const dirtyBlocks = new Set(this.#unfinishedBlocks);
		for (const key of dirty) {
			dirtyBlocks.add(index.containers.get(key)?.blockKey ?? key);
			yield undefined;
		}
		this.#dirtyContainers = dirty;
		this.#current = current;
		this.#activeKey = activeKey;
		this.#view = view;
		this.#items = items;
		this.#triggers = triggers;
		this.#annotationVersions = annotationVersions;
		this.#activationVersions = activationVersions;
		this.#patchVersions = patchVersions;

		function patchAnnotation(patch: Patch | ChangeOrigin): Annotation {
			const { change } = patch;
			const start = pointPosition(index, change.range.start),
				end = pointPosition(index, change.range.end);
			// Real trigger validation stays independent of visual effect coverage.
			const trigger = changeTriggerOwner(index, triggers, change) as OwnedTrigger | undefined;
			const memberships = annotationsByContainer
				.get(localContainer(index, change.range))!
				.filter((o) =>
					start === end
						? (o.start === start && o.end === end) || (o.start < start && o.end > end)
						: o.start <= start && o.end >= end
				);
			const actualTrigger = trigger
				? prioritized.get(triggerAnnotationId(trigger.itemId, trigger.id))
				: undefined;
			const explicitEffect = patch.effect ? prioritized.get(patch.effect.id) : undefined;
			return {
				annotations: [
					...new Map(
						[
							...memberships,
							...(actualTrigger ? [actualTrigger] : []),
							...(explicitEffect ? [explicitEffect] : [])
						].map((o) => [o.id, o])
					).values()
				],
				visualSource: change.range,
				generatedOffset: 0
			};
		}
		const separator = (owner: Annotation, marks?: ResolvedRun['marks']): ResolvedRun => ({
			text: ' ',
			...(marks !== undefined ? { marks } : {}),
			...owner,
			generated: 'separator'
		});
		function replacement(
			atoms: readonly ReplacementAtom[],
			owner: Annotation,
			baseOffset = 0
		): ResolvedRun[] {
			let offset = baseOffset;
			return atoms.map((atom) => {
				const text = atom.kind === 'text' ? atom.text : referenceText(atom, current);
				const run: ResolvedRun = {
					text,
					generated: 'replacement',
					...(atom.marks !== undefined ? { marks: atom.marks } : {}),
					...owner,
					generatedOffset: offset,
					...(view === 'redline' ? { revision: 'added' as const } : {})
				};
				offset += text.length;
				return run;
			});
		}
		function sourceSlice(
			container: SourceContainer,
			start: number,
			end: number,
			removed = false
		): ResolvedRun[] {
			const localAnnotations = annotationsByContainer.get(container.containerKey)!;
			const result: ResolvedRun[] = [];
			for (const unit of container.units) {
				const from = Math.max(start, unit.position),
					to = Math.min(end, unit.position + unit.length);
				if (from >= to) continue;
				const cuts = [
					...new Set([
						from,
						to,
						...localAnnotations.flatMap((o) => [o.start, o.end]).filter((p) => p > from && p < to)
					])
				].sort((a, b) => a - b);
				for (let i = 0; i < cuts.length - 1; i++) {
					const a = cuts[i],
						b = cuts[i + 1];
					const source: SourceRange = {
						start: { sourceKey: unit.sourceKey, offset: a - unit.position },
						end: { sourceKey: unit.sourceKey, offset: b - unit.position }
					};
					const activation = activations.get(unit.blockKey);
					const sourceMemberships = localAnnotations.filter((o) => o.start <= a && o.end >= b);
					const owner: Annotation =
						unit.kind === 'number' && activation && !removed
							? patchAnnotation(activation)
							: { annotations: sourceMemberships };
					const sourceAtom = atomsByKey.get(unit.sourceKey);
					const marks =
						unit.kind === 'number'
							? index.blocks.get(unit.blockKey)?.numbering?.marks
							: sourceAtom?.marks;
					const base: Omit<ResolvedRun, 'text'> = {
						...(unit.kind === 'number' && activation && !removed
							? { generated: 'activation-number' as const }
							: { source }),
						sourceKind: unit.kind,
						...(marks !== undefined ? { marks } : {}),
						...owner
					};
					if (unit.kind === 'text') {
						result.push({
							...base,
							text: unit.displayText.slice(a - unit.position, b - unit.position),
							...(removed ? { revision: 'removed' as const } : {})
						});
						continue;
					}
					const before = unit.displayText;
					let text: string;
					if (unit.kind === 'number') {
						const address = current.get(unit.sourceKey.slice('number:'.length));
						if (!address) throw new Error(`Missing number: ${unit.sourceKey}`);
						text = address.label;
					} else {
						const atom = atomsByKey.get(unit.sourceKey);
						if (atom?.kind !== 'reference')
							throw new Error(`Missing reference atom: ${unit.sourceKey}`);
						text = referenceText(atom, current);
					}
					if (removed) result.push({ ...base, text: before, revision: 'removed' });
					else if (view === 'redline' && before !== text) {
						if (before)
							result.push(
								{
									...base,
									annotations: sourceMemberships,
									source,
									generated: undefined,
									visualSource: undefined,
									generatedOffset: undefined,
									text: before,
									revision: 'removed'
								},
								...(unit.kind === 'number' ? [separator(owner, marks)] : [])
							);
						result.push({ ...base, text, revision: 'added' });
					} else result.push({ ...base, text });
					if (unit.kind === 'number' && (!removed || end > unit.position + unit.length))
						result.push(separator(owner, marks));
				}
			}
			return result;
		}
		function renderReadableRedline(
			container: SourceContainer,
			patch: Patch,
			owner: Annotation
		): ResolvedRun[] | null {
			const { change, start, end } = patch;
			if (
				!unitsInRange(index, change.range).every((unit) => unit.kind === 'text') ||
				!change.replacement.every((atom) => atom.kind === 'text') ||
				change.replacement.some((atom) => atom.marks !== undefined)
			)
				return null;
			const before = rangeText(index, change.range);
			// Only ordinary text has a one-to-one mapping from UTF-16 lengths to coordinates.
			if (before.length !== end - start) return null;
			const after = change.replacement.map((atom) => atom.text).join('');
			const parts = diffRedlineText(before, after);
			if (!parts) return null;
			const runs: ResolvedRun[] = [];
			let sourceCursor = start,
				replacementCursor = 0;
			for (const [i, part] of parts.entries()) {
				if (part.kind === 'insert') {
					const previous = parts[i - 1];
					if (previous?.kind === 'delete' && needsRedlineSeparator(previous.text, part.text))
						runs.push(separator(owner));
					runs.push(...replacement([{ kind: 'text', text: part.text }], owner, replacementCursor));
				} else {
					runs.push(
						...sourceSlice(
							container,
							sourceCursor,
							sourceCursor + part.text.length,
							part.kind === 'delete'
						)
					);
					sourceCursor += part.text.length;
				}
				// Equal source spans still occupy positions in the complete replacement wording.
				if (part.kind !== 'delete') replacementCursor += part.text.length;
			}
			return sourceCursor === end && replacementCursor === after.length ? runs : null;
		}
		const cache = this.#containers;
		const engine = this;
		function composeContainer(container: SourceContainer): ResolvedRun[] {
			const key = container.containerKey;
			const cached = cache.get(key);
			if (!engine.#dirtyContainers.has(key) && cached) return cached.content;
			const localChanges = patches.get(key) ?? [];
			// Replacement dependencies are refreshed with the immutable input, including range references.
			const targets = new Set(engine.#dependencies.get(key));
			for (const patch of localChanges)
				for (const atom of patch.change.replacement) {
					if (atom.kind !== 'reference') continue;
					targets.add(atom.targetItemKey);
					if (atom.endTargetItemKey) targets.add(atom.endTargetItemKey);
				}
			const version = JSON.stringify([
				view,
				engine.#annotationVersions.get(key),
				localChanges,
				[...targets].map((target) => [target, current.get(target)]),
				engine.#activationVersions.get(container.blockKey)
			]);
			if (cached?.version === version) {
				engine.#dirtyContainers.delete(key);
				return cached.content;
			}
			engine.affectedContainers++;
			const content = resolveContainer(container);
			cache.set(key, { version, content });
			engine.#dirtyContainers.delete(key);
			return content;
		}
		function resolveContainer(container: SourceContainer): ResolvedRun[] {
			const first = container.units[0],
				last = container.units.at(-1)!;
			const localPatches = (patches.get(container.containerKey) ?? []).sort(
				(a, b) => a.start - b.start || a.end - b.end
			);
			let cursor = first.position;
			const result: ResolvedRun[] = [];
			for (const patch of localPatches) {
				const { change, start, end } = patch;
				if (start < cursor)
					throw new Error(`Overlapping active changes in ${container.containerKey}`);
				result.push(...sourceSlice(container, cursor, start));
				const owner = patchAnnotation(patch);
				// Live previews stay whole-range; only saved concessions attempt readable redlines.
				const readable =
					view === 'redline' && end > start && patch.origin
						? renderReadableRedline(container, patch, owner)
						: null;
				if (readable) result.push(...readable);
				else {
					if (view === 'redline' && end > start) {
						result.push(...sourceSlice(container, start, end, true));
						if (
							change.replacement.some((atom) => atom.kind === 'reference' || atom.text.length > 0)
						)
							result.push(separator(owner));
					}
					result.push(...replacement(change.replacement, owner));
				}
				// Replacing only a generated label keeps its separator before the untouched
				// body. A deleted label still needs that spacing in redline view.
				if (
					first.kind === 'number' &&
					start === first.position &&
					end === first.position + first.length &&
					(view === 'redline' ||
						change.replacement.some((atom) => atom.kind === 'reference' || atom.text.length > 0))
				)
					result.push(separator(owner));
				cursor = end;
			}
			result.push(...sourceSlice(container, cursor, last.position + last.length));
			if (!result.some((run) => run.text)) {
				const memberships = annotationsByContainer
					.get(container.containerKey)!
					.filter((o) => o.start === o.end);
				if (memberships.length) return emptyHitTarget(memberships);
			}
			return result;
		}
		function trimAfterNumber(runs: ResolvedRun[]): ResolvedRun[] {
			if (runs[0]?.sourceKind !== 'number') return runs;
			let prefixEnd = 0;
			while (
				prefixEnd < runs.length &&
				(runs[prefixEnd].sourceKind === 'number' || runs[prefixEnd].generated === 'separator')
			)
				prefixEnd++;
			const prefix = runs.slice(0, prefixEnd);
			const body = runs.slice(prefixEnd);
			const first = body.findIndex((run) => /\S/u.test(run.text));
			if (first < 0) return prefix.at(-1)?.generated === 'separator' ? prefix.slice(0, -1) : prefix;
			const content = body.slice(first);
			const leading = /^\s+/u.exec(content[0].text)?.[0].length ?? 0;
			if (leading) {
				const run = content[0];
				content[0] = {
					...run,
					text: run.text.slice(leading),
					...(run.generatedOffset !== undefined
						? { generatedOffset: run.generatedOffset + leading }
						: {}),
					...(run.sourceKind === 'text' && run.source
						? {
								source: {
									start: { ...run.source.start, offset: run.source.start.offset + leading },
									end: run.source.end
								}
							}
						: {})
				};
			}
			return [...prefix, ...content];
		}
		function* resolveBlock(block: ContractBlock): Generator<undefined, ResolvedBlock> {
			if (block.kind === 'table') {
				const rows: { content: ResolvedRun[] }[][] = [];
				for (const [r, row] of block.rows.entries()) {
					const cells: { content: ResolvedRun[] }[] = [];
					for (const [c] of row.entries()) {
						cells.push({
							content: composeContainer(index.containers.get(`${block.blockKey}/cell/${r}/${c}`)!)
						});
						yield undefined;
					}
					rows.push(cells);
				}
				return {
					kind: 'table',
					blockKey: block.blockKey,
					...(block.variant ? { variant: block.variant } : {}),
					headerRowCount: block.headerRowCount,
					rows
				};
			}
			if (block.kind === 'paragraph' && block.optional && !activations.has(block.blockKey)) {
				const memberships = annotationsByContainer
					.get(block.blockKey)!
					.filter((o) => o.start === o.end);
				const version = engine.#annotationVersions.get(block.blockKey)!;
				let slot = engine.#slots.get(block.blockKey);
				if (slot?.version !== version) {
					slot = {
						version,
						content: emptyHitTarget(memberships)
					};
					engine.#slots.set(block.blockKey, slot);
				}
				engine.#dirtyContainers.delete(block.blockKey);
				return {
					kind: 'paragraph',
					blockKey: block.blockKey,
					emptyInsertionSlot: true,
					content: slot!.content
				};
			}
			const raw = composeContainer(index.containers.get(block.blockKey)!);
			let content = engine.#trimmed.get(raw);
			if (!content) {
				content = trimAfterNumber(raw);
				engine.#trimmed.set(raw, content);
			}
			return block.kind === 'heading'
				? {
						kind: 'heading',
						blockKey: block.blockKey,
						anchor: block.anchor,
						level: block.level,
						content
					}
				: { kind: 'paragraph', blockKey: block.blockKey, content };
		}
		// Idle alternatives only need changed blocks and their numbering/reference dependencies.
		function* candidates() {
			if (changedOnly) {
				for (const key of dirtyBlocks) yield index.blocks.get(key)!;
			} else yield* blocks;
		}
		for (const block of candidates()) {
			const previous = this.#resolved.get(block.blockKey);
			if (previous && !dirtyBlocks.has(block.blockKey)) {
				yield previous;
				continue;
			}
			this.#unfinishedBlocks.add(block.blockKey);
			const next = yield* resolveBlock(block);
			let unchanged = Boolean(previous && previous.kind === next.kind);
			if (unchanged && previous?.kind === 'table' && next.kind === 'table') {
				for (const [r, row] of previous.rows.entries())
					for (const [c, cell] of row.entries()) {
						if (cell.content !== next.rows[r][c].content) unchanged = false;
						yield undefined;
					}
			} else
				unchanged = Boolean(
					previous &&
					previous.kind !== 'table' &&
					next.kind !== 'table' &&
					previous.content === next.content
				);
			this.#unfinishedBlocks.delete(block.blockKey);
			if (unchanged) {
				if (!changedOnly) yield previous!;
			} else {
				this.recomposedBlocks++;
				this.#resolved.set(block.blockKey, next);
				yield next;
			}
		}
	}
}
