import type { ConcessionSelection } from '../playbook/model';
import type { ContractBlock, ContractView, ResolvedBlock, ResolvedRun } from './model';
import type { Trigger, ContractChange, SourceRange, SourceTarget } from '../playbook/model';
import { isTextTarget, type InlineSource, type ReplacementAtom } from './source-model';
import {
	triggerAnnotationId,
	type AnnotationMembership,
	type DocumentOverlayItem
} from '../playbook/document-overlay';
import { changeTriggerOwner } from '../playbook/geometry';
import {
	buildSourceIndex,
	iterateSourceIndex,
	type SourceIndex,
	pointPosition,
	type SourceContainer
} from './source-index';
import { localContainer, targetContainers, targetPosition, unitsInRange } from './ranges';
import { diffRedlineTokens, redlineTextTokens, type RedlineToken } from './redline-diff';
import { canonicalNumberPattern } from './number-pattern';
import { referenceText, iterateNumberAddresses, type Address } from './numbering';
import { createChangeConflictChecker } from '../playbook/conflicts';
import {
	planStructuralChanges,
	type ChangeOrigin,
	type ReplacementAnnotation,
	type GeneratedParagraph
} from './structural-changes';

type OwnedTrigger = Trigger & { itemId: string };
type PositionedAnnotation = AnnotationMembership & { start: number; end: number };
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
		{
			annotations: PositionedAnnotation[];
			containers: Map<string, PositionedAnnotation[]>;
			boundaries: Map<string, AnnotationMembership[]>;
		}
	>();
	#annotationVersions = new Map<string, string>();
	#dependencies = new Map<string, Set<string>>();
	#containers = new Map<string, { version: string; content: ResolvedRun[] }>();
	#trimmed = new WeakMap<ResolvedRun[], ResolvedRun[]>();
	#resolved = new Map<string, ResolvedBlock>();
	#generated = new Map<string, { version: string; content: ResolvedRun[] }>();
	#activeKey = '';
	#view?: ContractView;
	#patchVersions = new Map<string, string>();
	#dirtyContainers = new Set<string>();
	#current: ReadonlyMap<string, Address> = new Map();
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
		this.#current = index.addresses;
		this.#atomsByKey = atoms;
		this.#dependencies = dependencies;
		this.#dirtyContainers = dirty;
		this.#initialized = true;
	}
	/** Numbering accepted by the most recent composition, including inserted paragraphs. */
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
		const authoredChanges: ChangeOrigin[] = [];
		for (const item of items) {
			const concession = item.concessions.find((c) => c.id === activeConcessions[item.itemId]);
			for (const [changeIndex, change] of (concession?.changes ?? []).entries()) {
				authoredChanges.push({
					change,
					origin: { itemId: item.itemId, concessionId: concession!.id, changeIndex },
					annotation: {
						range: change.range,
						effect: item.annotations.find(
							(annotation) =>
								annotation.kind === 'concession-effect' &&
								annotation.concessionId === concession!.id &&
								annotation.changeIndex === changeIndex
						)
					}
				});
				yield undefined;
			}
			yield undefined;
		}
		for (const change of previewChanges) {
			authoredChanges.push({ change, annotation: { range: change.range } });
			yield undefined;
		}
		const authoredConflicts = createChangeConflictChecker(index);
		for (const [i, patch] of authoredChanges.entries()) {
			if (
				authoredChanges.slice(0, i).some((other) => authoredConflicts(other.change, patch.change))
			)
				throw new Error('Conflicting active changes');
			yield undefined;
		}
		const structural = planStructuralChanges(index, blocks, authoredChanges);
		const changes = structural.changes;
		// Construct and validate the entire candidate before changing accepted input state.
		const previousAddresses = this.#current;
		const topology =
			structural.generated.size || structural.removed.size
				? structural.numberingBlocks.map((block) => [block.blockKey, block.numbering])
				: undefined;
		const activeKey = JSON.stringify([topology, [...structural.aliases]]);
		const current =
			!topology && !structural.aliases.size
				? index.addresses
				: activeKey === this.#activeKey
					? previousAddresses
					: yield* iterateNumberAddresses(structural.numberingBlocks, structural.aliases);
		// Resolve displayed offsets once per authored replacement, after numbering is known.
		for (const { annotations, paragraphs } of structural.replacementGroups) {
			let offset = 0;
			for (const [i, atoms] of paragraphs.entries()) {
				if (annotations[i]) annotations[i].replacementOffset = offset;
				offset +=
					atoms.reduce(
						(length, atom) =>
							length +
							(atom.kind === 'text'
								? atom.text.length
								: atom.kind === 'reference'
									? referenceText(atom, current).length
									: 0),
						0
					) + 1;
			}
		}
		const triggers = items === this.#items ? this.#triggers : [];
		if (items !== this.#items)
			for (const item of items) {
				triggers.push({ ...item.trigger, itemId: item.itemId });
				yield undefined;
			}
		const overlays: {
			annotations: PositionedAnnotation[];
			containers: Map<string, PositionedAnnotation[]>;
			boundaries: Map<string, AnnotationMembership[]>;
		}[] = [];
		for (const item of items) {
			let cached = this.#overlay.get(item);
			if (!cached) {
				const annotations: PositionedAnnotation[] = [];
				const containers = new Map<string, PositionedAnnotation[]>();
				const boundaries = new Map<string, AnnotationMembership[]>();
				for (const annotation of item.annotations) {
					if (!isTextTarget(annotation.range)) {
						const local = boundaries.get(annotation.range.afterBlockKey) ?? [];
						local.push(annotation);
						boundaries.set(annotation.range.afterBlockKey, local);
						yield undefined;
						continue;
					}
					const positioned = {
						...annotation,
						start: pointPosition(index, annotation.range.range.start),
						end: pointPosition(index, annotation.range.range.end)
					};
					annotations.push(positioned);
					for (const container of targetContainers(index, annotation.range)) {
						const local = containers.get(container.containerKey) ?? [];
						local.push(positioned);
						containers.set(container.containerKey, local);
					}
					yield undefined;
				}
				cached = { annotations, containers, boundaries };
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
		const annotationsByBoundary = new Map<string, AnnotationMembership[]>();
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
		for (const overlay of overlays)
			for (const [key, annotations] of overlay.boundaries) {
				const local = annotationsByBoundary.get(key) ?? [];
				local.push(...annotations);
				annotationsByBoundary.set(key, local);
				yield undefined;
			}
		const annotationVersions = new Map<string, string>();
		for (const [key, annotations] of annotationsByContainer) {
			annotationVersions.set(key, JSON.stringify(annotations));
			yield undefined;
		}
		const patches = new Map<string, Patch[]>();
		for (const patch of changes) {
			const { change } = patch;
			const range = change.range;
			if (!isTextTarget(range))
				throw new Error(`Boundary change escaped structural planning: ${range.afterBlockKey}`);
			const key = localContainer(index, range.range);
			const items = patches.get(key) ?? [];
			// Conflicts are checked on authored locations before expansion. A derived
			// insertion can share an endpoint with a disjoint authored text change.
			items.push({
				...patch,
				start: pointPosition(index, range.range.start),
				end: pointPosition(index, range.range.end)
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
		for (const [key, override] of structural.numberingOverrides)
			replacementDependencies.set(key, new Set([override.numbering.itemKey]));
		for (const [key, localPatches] of patches) {
			const targets = replacementDependencies.get(key) ?? new Set<string>();
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
		for (const transfer of structural.transfers)
			if (dirty.has(transfer.from)) dirty.add(transfer.to);
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
		this.#patchVersions = patchVersions;

		function patchAnnotation(annotation: ReplacementAnnotation): Annotation {
			const selection = annotation.range;
			// Real trigger validation stays independent of visual effect coverage.
			const trigger = changeTriggerOwner(index, triggers, { range: selection, replacement: [] }) as
				OwnedTrigger | undefined;
			const memberships = isTextTarget(selection)
				? (() => {
						const start = pointPosition(index, selection.range.start);
						const end = pointPosition(index, selection.range.end);
						return annotationsByContainer
							.get(index.byKey.get(selection.range.start.sourceKey)!.containerKey)!
							.filter((o) =>
								start === end
									? (o.start === start && o.end === end) || (o.start < start && o.end > end)
									: o.start <= start && o.end >= end
							);
					})()
				: (annotationsByBoundary.get(selection.afterBlockKey) ?? []).map(
					(annotation) => prioritized.get(annotation.id)!
				);
			const actualTrigger = trigger
				? prioritized.get(triggerAnnotationId(trigger.itemId, trigger.id))
				: undefined;
			const explicitEffect = annotation.effect ? prioritized.get(annotation.effect.id) : undefined;
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
				visualSource: selection,
				generatedOffset: annotation.replacementOffset ?? 0
			};
		}
		const separator = (owner: Annotation): ResolvedRun => ({
			text: ' ',
			...owner,
			generated: 'separator'
		});
		function replacement(
			atoms: readonly ReplacementAtom[],
			owner: Annotation,
			baseOffset = owner.generatedOffset ?? 0
		): ResolvedRun[] {
			let offset = baseOffset;
			return atoms.map((atom) => {
				if (atom.kind === 'paragraph-break') throw new Error('Unexpanded replacement paragraph');
				const text = atom.kind === 'text' ? atom.text : referenceText(atom, current);
				const run: ResolvedRun = {
					text,
					generated: 'replacement',
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
					const sourceMemberships = localAnnotations.filter((o) => o.start <= a && o.end >= b);
					const owner: Annotation = { annotations: sourceMemberships };
					const base: Omit<ResolvedRun, 'text'> = {
						source,
						sourceKind: unit.kind,
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
					if (removed) {
						result.push({ ...base, text: before, revision: 'removed' });
						if (unit.kind === 'number' && end > unit.position + unit.length)
							result.push(separator(owner));
						continue;
					}
					let text: string;
					if (unit.kind === 'number') {
						const address = current.get(unit.sourceKey.slice('number:'.length));
						if (!address && !structural.removed.has(unit.blockKey))
							throw new Error(`Missing number: ${unit.sourceKey}`);
						text = structural.removed.has(unit.blockKey) ? before : (address?.label ?? before);
					} else {
						const atom = atomsByKey.get(unit.sourceKey);
						if (atom?.kind !== 'reference')
							throw new Error(`Missing reference atom: ${unit.sourceKey}`);
						text = referenceText(atom, current);
					}
					if (view === 'redline' && before !== text) {
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
								...(unit.kind === 'number' ? [separator(owner)] : [])
							);
						result.push({ ...base, text, revision: 'added' });
					} else result.push({ ...base, text });
					if (unit.kind === 'number') result.push(separator(owner));
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
			if (!isTextTarget(change.range)) return null;
			const units = unitsInRange(index, change.range.range);
			// Generated clause labels keep their existing whole-range presentation.
			if (units.some((unit) => unit.kind === 'number')) return null;
			const originalReferences = new Map<ReplacementAtom, string>(
				units
					.filter((unit) => unit.kind === 'reference')
					.map((unit) => [atomsByKey.get(unit.sourceKey)!, unit.displayText])
			);
			type Token = RedlineToken & { length: number; atom: ReplacementAtom };
			function tokenize(atoms: readonly ReplacementAtom[], original = false): Token[] {
				const result: Token[] = [];
				let text = '';
				function flush() {
					for (const token of redlineTextTokens(text))
						result.push({
							...token,
							length: token.text.length,
							atom: { kind: 'text', text: token.text }
						});
					text = '';
				}
				for (const atom of atoms) {
					if (atom.kind === 'paragraph-break') throw new Error('Unexpanded replacement paragraph');
					if (atom.kind === 'text') {
						text += atom.text;
						continue;
					}
					flush();
					const display = original ? originalReferences.get(atom)! : referenceText(atom, current);
					result.push({
						key: JSON.stringify([
							'reference',
							atom.targetItemKey,
							atom.endTargetItemKey ?? null,
							canonicalNumberPattern(atom.display.start),
							atom.display.end ? canonicalNumberPattern(atom.display.end) : null,
							atom.display.separator ?? null
						]),
						text: display,
						length: original ? 1 : display.length,
						atom
					});
				}
				flush();
				return result;
			}
			const sourceAtoms: ReplacementAtom[] = units.map((unit) =>
				unit.kind === 'text'
					? {
							kind: 'text',
							text: unit.displayText.slice(
								Math.max(start - unit.position, 0),
								Math.min(end - unit.position, unit.length)
							)
						}
					: atomsByKey.get(unit.sourceKey)!
			);
			const source = tokenize(sourceAtoms, true),
				inserted = tokenize(change.replacement);
			function offsets(tokens: readonly Token[]) {
				const result = [0];
				for (const token of tokens) result.push(result.at(-1)! + token.length);
				return result;
			}
			const sourceOffsets = offsets(source),
				replacementOffsets = offsets(inserted);
			if (sourceOffsets.at(-1) !== end - start) return null;
			const parts = diffRedlineTokens(source, inserted);
			if (!parts) return null;
			const runs: ResolvedRun[] = [];
			for (const [i, part] of parts.entries()) {
				if (part.kind !== 'insert') {
					runs.push(
						...sourceSlice(
							container,
							start + sourceOffsets[part.sourceStart],
							start + sourceOffsets[part.sourceEnd],
							part.kind === 'delete'
						)
					);
					continue;
				}
				const atoms: ReplacementAtom[] = [];
				for (const { atom } of inserted.slice(part.replacementStart, part.replacementEnd)) {
					const last = atoms.at(-1);
					if (last?.kind === 'text' && atom.kind === 'text') last.text += atom.text;
					else atoms.push({ ...atom });
				}
				const previous = parts[i - 1];
				if (
					previous?.kind === 'delete' &&
					needsRedlineSeparator(
						source
							.slice(previous.sourceStart, previous.sourceEnd)
							.map((token) => token.text)
							.join(''),
						inserted
							.slice(part.replacementStart, part.replacementEnd)
							.map((token) => token.text)
							.join('')
					)
				)
					runs.push(separator(owner));
				runs.push(
					...replacement(
						atoms,
						owner,
						(owner.generatedOffset ?? 0) + replacementOffsets[part.replacementStart]
					)
				);
			}
			return runs;
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
				[...targets].map((target) => [target, current.get(target)])
			]);
			if (cached?.version === version) {
				engine.#dirtyContainers.delete(key);
				return cached.content;
			}
			engine.affectedContainers++;
			const content = resolveContainer(container);
			cache.set(key, { version, content });
			// Transfers can prepare this container before its block reaches rendering.
			engine.#unfinishedBlocks.add(container.blockKey);
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
				const owner = patchAnnotation(patch.annotation);
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
							change.replacement.some(
								(atom) =>
									atom.kind === 'reference' || (atom.kind === 'text' && atom.text.length > 0)
							)
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
						change.replacement.some(
							(atom) => atom.kind === 'reference' || (atom.kind === 'text' && atom.text.length > 0)
						))
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
		function belongsAfter(run: ResolvedRun, position: number): boolean {
			const source = run.source ?? (run.visualSource?.kind === 'text' ? run.visualSource.range : undefined);
			return Boolean(source && pointPosition(index, source.start) >= position);
		}
		const incoming = new Map<string, ResolvedRun[]>();
		const sourceContents = new Map<string, ResolvedRun[]>();
		const cutoffs = new Map<string, number>();
		function withIncoming(key: string, content: ResolvedRun[]): ResolvedRun[] {
			const suffix = incoming.get(key);
			return suffix?.length ? [...content, ...suffix] : content;
		}
		// Later source paragraphs are prepared first, so a merged suffix keeps text
		// received from another merge. Each split takes a bounded, disjoint slice.
		for (const transfer of structural.transfers) {
			let content = sourceContents.get(transfer.from);
			if (!content) {
				content = withIncoming(
					transfer.from,
					composeContainer(index.containers.get(transfer.from)!)
				);
				sourceContents.set(transfer.from, content);
			}
			const suffix = content.filter(
				(run) =>
					belongsAfter(run, transfer.after) &&
					(transfer.before === undefined || !belongsAfter(run, transfer.before))
			);
			incoming.set(transfer.to, [...(incoming.get(transfer.to) ?? []), ...suffix]);
			if (!cutoffs.has(transfer.from)) cutoffs.set(transfer.from, transfer.after);
		}
		function transferContent(key: string, content: ResolvedRun[]): ResolvedRun[] {
			const result = sourceContents.get(key) ?? withIncoming(key, content);
			const cutoff = cutoffs.get(key);
			return cutoff === undefined ? result : result.filter((run) => !belongsAfter(run, cutoff));
		}
		function numberPrefix(numbering: ContractBlock['numbering'], owner: Annotation): ResolvedRun[] {
			if (!numbering) return [];
			const number = current.get(numbering.itemKey);
			if (!number) throw new Error(`Missing number: ${numbering.itemKey}`);
			return [
				{
					text: number.label,
					sourceKind: 'number',
					generated: 'number',
					...owner,
					...(view === 'redline' ? { revision: 'added' as const } : {})
				},
				separator(owner)
			];
		}
		function resolveGenerated(
			paragraph: GeneratedParagraph
		): Extract<ResolvedBlock, { kind: 'paragraph' }> {
			const { block, atoms } = paragraph;
			const key = block.blockKey;
			const targets = new Set(block.numbering ? [block.numbering.itemKey] : []);
			for (const atom of atoms)
				if (atom.kind === 'reference') {
					targets.add(atom.targetItemKey);
					if (atom.endTargetItemKey) targets.add(atom.endTargetItemKey);
				}
			const version = JSON.stringify([
				view,
				paragraph,
				[...targets].map((target) => [target, current.get(target)]),
				incoming.get(key),
				isTextTarget(paragraph.annotation.range)
					? annotationsByContainer.get(
							index.byKey.get(paragraph.annotation.range.range.start.sourceKey)!.containerKey
						)
					: annotationsByBoundary.get(paragraph.annotation.range.afterBlockKey)
			]);
			let cached = engine.#generated.get(key);
			if (cached?.version !== version) {
				const owner = patchAnnotation(paragraph.annotation);
				const prefix = numberPrefix(block.numbering, owner);
				cached = {
					version,
					content: trimAfterNumber(transferContent(key, [...prefix, ...replacement(atoms, owner)]))
				};
				engine.#generated.set(key, cached);
			}
			return { kind: 'paragraph', blockKey: key, content: cached.content };
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
			let raw = composeContainer(index.containers.get(block.blockKey)!);
			raw = transferContent(block.blockKey, raw);
			const promoted = structural.numberingOverrides.get(block.blockKey);
			if (promoted && !block.numbering) {
				raw = [...numberPrefix(promoted.numbering, patchAnnotation(promoted.annotation)), ...raw];
			}
			if (structural.removed.has(block.blockKey))
				raw = raw.map((run) => ({ ...run, revision: 'removed' as const }));
			let content = engine.#trimmed.get(raw);
			if (!content) {
				content = trimAfterNumber(raw);
				engine.#trimmed.set(raw, content);
			}
			const boundariesAfter = index.structuralBoundaries.get(block.blockKey);
			return block.kind === 'heading'
				? {
						kind: 'heading',
						blockKey: block.blockKey,
						anchor: block.anchor,
						level: block.level,
						content,
						...(boundariesAfter ? { boundariesAfter: [boundariesAfter] } : {})
					}
				: {
						kind: 'paragraph',
						blockKey: block.blockKey,
						content,
						...(boundariesAfter ? { boundariesAfter: [boundariesAfter] } : {})
					};
		}
		// Idle alternatives only need changed blocks and their numbering/reference dependencies.
		function* candidates() {
			if (changedOnly) {
				for (const key of dirtyBlocks) {
					const block = index.blocks.get(key);
					if (block) yield block;
				}
			} else yield* blocks;
		}
		function* generatedAt(anchor: string) {
			for (const paragraph of structural.generated.get(anchor) ?? []) {
				const next = resolveGenerated(paragraph);
				const previous = engine.#resolved.get(next.blockKey);
				if (previous?.kind === 'paragraph' && previous.content === next.content) {
					if (!changedOnly) yield previous;
				} else {
					engine.#resolved.set(next.blockKey, next);
					engine.recomposedBlocks++;
					yield next;
				}
			}
		}
		yield* generatedAt('');
		for (const block of candidates()) {
			const previous = this.#resolved.get(block.blockKey);
			if (previous && !dirtyBlocks.has(block.blockKey)) {
				if (view !== 'effective' || !structural.removed.has(block.blockKey)) yield previous;
				yield* generatedAt(block.blockKey);
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
				if (!changedOnly && (view !== 'effective' || !structural.removed.has(block.blockKey)))
					yield previous!;
			} else {
				this.recomposedBlocks++;
				this.#resolved.set(block.blockKey, next);
				if (view !== 'effective' || !structural.removed.has(block.blockKey)) yield next;
			}
			yield* generatedAt(block.blockKey);
		}
		// Alternative warming may have no dirty baseline block at a pure insertion boundary.
		if (changedOnly)
			for (const anchor of structural.generated.keys())
				if (anchor && !dirtyBlocks.has(anchor)) yield* generatedAt(anchor);
		const generatedKeys = new Set(
			[...structural.generated.values()].flat().map((paragraph) => paragraph.block.blockKey)
		);
		for (const key of engine.#generated.keys())
			if (!generatedKeys.has(key)) {
				engine.#generated.delete(key);
				engine.#resolved.delete(key);
			}
	}
}
