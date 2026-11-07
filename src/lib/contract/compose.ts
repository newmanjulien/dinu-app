import { createChangeConflictChecker } from '../playbook/conflicts';
import {
	triggerAnnotationId,
	type AnnotationMembership,
	type DocumentOverlayItem
} from '../playbook/document-overlay';
import { changeTriggerOwner } from '../playbook/geometry';
import type { ConcessionSelection, ContractChange, SourceRange, Trigger } from '../playbook/model';
import {
	createCompositionRequest,
	type CompositionArtifact,
	type CompositionArtifactStore,
	type CompositionRequest
} from './composition-artifacts';
import type { ContractBlock, ContractView, ResolvedBlock, ResolvedRun } from './model';
import { canonicalNumberPattern } from './number-pattern';
import { iterateNumberAddresses, referenceText, type Address } from './numbering';
import { localContainer, targetContainers, unitsInRange } from './ranges';
import { iterateRedlineDiff, iterateRedlineTextTokens, type RedlineToken } from './redline-diff';
import {
	buildSourceIndex,
	iterateSourceIndex,
	pointPosition,
	type SourceContainer,
	type SourceIndex
} from './source-index';
import { isTextTarget, type InlineSource, type ReplacementAtom } from './source-model';
import {
	planStructuralChanges,
	type ChangeOrigin,
	type GeneratedParagraph,
	type ReplacementAnnotation
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
			visualSource: annotations[0]?.target,
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
	#blocks: readonly ContractBlock[];
	#numberingBlocks: readonly ContractBlock[] = [];
	#atomsByKey = new Map<string, InlineSource>();
	#items?: readonly DocumentOverlayItem[];
	#triggers: { text: OwnedTrigger[]; boundary: OwnedTrigger[] } = { text: [], boundary: [] };
	#overlay = new WeakMap<
		DocumentOverlayItem,
		{
			annotations: PositionedAnnotation[];
			containers: Map<string, PositionedAnnotation[]>;
			boundaries: Map<string, AnnotationMembership[]>;
		}
	>();
	#dependencies = new Map<string, Set<string>>();
	#activeKey = '';
	#current: ReadonlyMap<string, Address> = new Map();
	recomposedBlocks = 0;
	affectedContainers = 0;
	reusedContainers = 0;
	reusedResolvedBlocks = 0;
	constructor(
		blocks: readonly ContractBlock[],
		index?: SourceIndex,
		readonly artifacts?: CompositionArtifactStore
	) {
		this.artifacts?.useSource(blocks);
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
			if (block.kind !== 'table') for (const atom of block.content) atoms.set(atom.sourceKey, atom);
			yield undefined;
		}
		const dependencies = new Map<string, Set<string>>();
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
			yield undefined;
		}
		this.#index = index;
		this.#current = index.addresses;
		this.#atomsByKey = atoms;
		this.#dependencies = dependencies;
		this.#initialized = true;
	}
	/** Effective source graph accepted by the latest composition, including inserted paragraphs. */
	get numberingBlocks(): readonly ContractBlock[] {
		return this.#numberingBlocks;
	}
	/** Numbering accepted by the most recent composition, including inserted paragraphs. */
	get addresses(): ReadonlyMap<string, Address> {
		return this.#current;
	}
	*compose(input: CompositionInput): Generator<ResolvedBlock> {
		for (const block of this.iterate(input)) if (block) yield block;
	}
	*iterate(
		input: CompositionInput,
		working?: CompositionRequest
	): Generator<ResolvedBlock | undefined, void> {
		const request = working ?? createCompositionRequest(this.artifacts);
		if (request.owner !== this.artifacts)
			throw new Error('Composition request belongs to a different source.');
		try {
			yield* this.#iterate(input, request);
		} finally {
			if (!working) request.release();
		}
	}
	*#iterate(
		{ items, activeConcessions, previewChanges = [], view }: CompositionInput,
		request: CompositionRequest
	): Generator<ResolvedBlock | undefined, void> {
		yield* this.#initialize();
		const blocks = this.#blocks,
			index = this.index,
			atomsByKey = this.#atomsByKey;
		this.recomposedBlocks = 0;
		this.affectedContainers = 0;
		this.reusedContainers = 0;
		this.reusedResolvedBlocks = 0;
		const authoredChanges: ChangeOrigin[] = [];
		for (const item of items) {
			const concession = item.concessions.find((c) => c.id === activeConcessions[item.itemId]);
			for (const [changeIndex, change] of (concession?.changes ?? []).entries()) {
				authoredChanges.push({
					change,
					origin: { itemId: item.itemId, concessionId: concession!.id, changeIndex },
					annotation: {
						target: change.target,
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
			authoredChanges.push({ change, annotation: { target: change.target } });
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
		const triggers = items === this.#items ? this.#triggers : { text: [], boundary: [] };
		if (items !== this.#items)
			for (const item of items) {
				triggers[item.trigger.target.kind].push({ ...item.trigger, itemId: item.itemId });
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
					if (!isTextTarget(annotation.target)) {
						const local = boundaries.get(annotation.target.afterBlockKey) ?? [];
						local.push(annotation);
						boundaries.set(annotation.target.afterBlockKey, local);
						yield undefined;
						continue;
					}
					const positioned = {
						...annotation,
						start: pointPosition(index, annotation.target.range.start),
						end: pointPosition(index, annotation.target.range.end)
					};
					annotations.push(positioned);
					for (const container of targetContainers(index, annotation.target)) {
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
		const prioritized = new Map<string, AnnotationMembership>();
		for (const overlay of overlays)
			for (const annotation of [
				...overlay.annotations,
				...[...overlay.boundaries.values()].flat()
			]) {
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
					.push(
						...annotations.map(
							(annotation) => prioritized.get(annotation.id)! as PositionedAnnotation
						)
					);
				yield undefined;
			}
		for (const overlay of overlays)
			for (const [key, annotations] of overlay.boundaries) {
				const local = annotationsByBoundary.get(key) ?? [];
				local.push(...annotations.map((annotation) => prioritized.get(annotation.id)!));
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
			const range = change.target;
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
		// Accepted cursor metadata contains no completed content or alternative token arrays.
		this.#current = current;
		this.#numberingBlocks = structural.numberingBlocks;
		this.#activeKey = activeKey;
		this.#items = items;
		this.#triggers = triggers;
		const patchOwners = new WeakMap<ReplacementAnnotation, Annotation>();

		function patchAnnotation(annotation: ReplacementAnnotation): Annotation {
			const cached = patchOwners.get(annotation);
			if (cached) return cached;
			const selection = annotation.target;
			// Attachment owners share the target kind; authoring validates all structural effects.
			const trigger = changeTriggerOwner(index, triggers[selection.kind], {
				target: selection,
				replacement: []
			}) as OwnedTrigger | undefined;
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
				: (annotationsByBoundary.get(selection.afterBlockKey) ?? []);
			const actualTrigger = trigger
				? prioritized.get(triggerAnnotationId(trigger.itemId))
				: undefined;
			const explicitEffect = annotation.effect ? prioritized.get(annotation.effect.id) : undefined;
			const owner: Annotation = {
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
			patchOwners.set(annotation, owner);
			return owner;
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
		function* sourceSlice(
			container: SourceContainer,
			start: number,
			end: number,
			removed = false
		): Generator<undefined, ResolvedRun[]> {
			const localAnnotations = annotationsByContainer.get(container.containerKey)!;
			const result: ResolvedRun[] = [];
			for (const unit of container.units) {
				yield undefined;
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
					if (i % 128 === 0) yield undefined;
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
		function* renderReadableRedline(
			container: SourceContainer,
			patch: Patch,
			owner: Annotation
		): Generator<undefined, ResolvedRun[] | null> {
			const { change, start, end } = patch;
			if (!isTextTarget(change.target)) return null;
			const units = unitsInRange(index, change.target.range);
			// Generated clause labels keep their existing whole-range presentation.
			if (units.some((unit) => unit.kind === 'number')) return null;
			const originalReferences = new Map<ReplacementAtom, string>(
				units
					.filter((unit) => unit.kind === 'reference')
					.map((unit) => [atomsByKey.get(unit.sourceKey)!, unit.displayText])
			);
			type Token = RedlineToken & { length: number; atom: ReplacementAtom };
			function* tokenize(
				atoms: readonly ReplacementAtom[],
				original = false
			): Generator<undefined, Token[]> {
				const result: Token[] = [];
				let text = '';
				function* flush(): Generator<undefined> {
					for (const token of yield* iterateRedlineTextTokens(text))
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
					yield* flush();
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
				yield* flush();
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
			const source = yield* tokenize(sourceAtoms, true);
			const inserted = yield* tokenize(change.replacement);
			function offsets(tokens: readonly Token[]) {
				const result = [0];
				for (const token of tokens) result.push(result.at(-1)! + token.length);
				return result;
			}
			const sourceOffsets = offsets(source),
				replacementOffsets = offsets(inserted);
			if (sourceOffsets.at(-1) !== end - start) return null;
			const parts = yield* iterateRedlineDiff(source, inserted);
			if (!parts) return null;
			const runs: ResolvedRun[] = [];
			for (const [i, part] of parts.entries()) {
				if (part.kind !== 'insert') {
					runs.push(
						...(yield* sourceSlice(
							container,
							start + sourceOffsets[part.sourceStart],
							start + sourceOffsets[part.sourceEnd],
							part.kind === 'delete'
						))
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
		const engine = this;
		const containers = new Map<string, CompositionArtifact<ResolvedRun[]>>();
		function* composeContainer(
			container: SourceContainer
		): Generator<undefined, CompositionArtifact<ResolvedRun[]>> {
			const key = container.containerKey;
			const existing = containers.get(key);
			if (existing) return existing;
			const localChanges = patches.get(key) ?? [];
			localChanges.sort((a, b) => a.start - b.start || a.end - b.end);
			const targets = new Set(engine.#dependencies.get(key));
			for (const patch of localChanges)
				for (const atom of patch.change.replacement) {
					if (atom.kind !== 'reference') continue;
					targets.add(atom.targetItemKey);
					if (atom.endTargetItemKey) targets.add(atom.endTargetItemKey);
				}
			const version = JSON.stringify([
				'container',
				key,
				view,
				annotationVersions.get(key),
				localChanges,
				localChanges.map((patch) => patchAnnotation(patch.annotation)),
				structural.removed.has(container.blockKey),
				[...targets].map((target) => [target, current.get(target)])
			]);
			let artifact = request.get<ResolvedRun[]>(version);
			if (artifact) engine.reusedContainers++;
			else {
				engine.affectedContainers++;
				artifact = request.put(version, yield* resolveContainer(container));
			}
			containers.set(key, artifact);
			return artifact;
		}
		function* resolveContainer(container: SourceContainer): Generator<undefined, ResolvedRun[]> {
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
				result.push(...(yield* sourceSlice(container, cursor, start)));
				const owner = patchAnnotation(patch.annotation);
				// Live previews stay whole-range; only saved concessions attempt readable redlines.
				const readable =
					view === 'redline' && end > start && patch.origin
						? yield* renderReadableRedline(container, patch, owner)
						: null;
				if (readable) result.push(...readable);
				else {
					if (view === 'redline' && end > start) {
						result.push(...(yield* sourceSlice(container, start, end, true)));
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
			result.push(...(yield* sourceSlice(container, cursor, last.position + last.length)));
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
			const source =
				run.source ?? (run.visualSource?.kind === 'text' ? run.visualSource.range : undefined);
			return Boolean(source && pointPosition(index, source.start) >= position);
		}
		const incoming = new Map<string, CompositionArtifact<ResolvedRun[]>[]>();
		const sourceContents = new Map<string, CompositionArtifact<ResolvedRun[]>>();
		const cutoffs = new Map<string, number>();
		const outgoing = new Map<string, typeof structural.transfers>();
		function withIncoming(
			key: string,
			content: CompositionArtifact<ResolvedRun[]>
		): CompositionArtifact<ResolvedRun[]> {
			const suffixes = incoming.get(key);
			if (!suffixes?.length) return content;
			const version = JSON.stringify([
				'incoming',
				key,
				content.id,
				suffixes.map((suffix) => suffix.id)
			]);
			return (
				request.get<ResolvedRun[]>(version) ??
				request.put(
					version,
					[...content.value, ...suffixes.flatMap((suffix) => suffix.value)],
					[content, ...suffixes]
				)
			);
		}
		// Preserve structural planning's ordered, disjoint suffix transfers. Their versions
		// reference immutable input versions instead of serializing expanded provenance.
		for (const transfer of structural.transfers) {
			let content = sourceContents.get(transfer.from);
			if (!content) {
				content = withIncoming(
					transfer.from,
					yield* composeContainer(index.containers.get(transfer.from)!)
				);
				sourceContents.set(transfer.from, content);
			}
			const version = JSON.stringify([
				'transfer',
				transfer.from,
				transfer.to,
				transfer.after,
				transfer.before,
				content.id
			]);
			const suffix =
				request.get<ResolvedRun[]>(version) ??
				request.put(
					version,
					content.value.filter(
						(run) =>
							belongsAfter(run, transfer.after) &&
							(transfer.before === undefined || !belongsAfter(run, transfer.before))
					),
					[content]
				);
			const destination = incoming.get(transfer.to) ?? [];
			destination.push(suffix);
			incoming.set(transfer.to, destination);
			const sources = outgoing.get(transfer.from) ?? [];
			sources.push(transfer);
			outgoing.set(transfer.from, sources);
			if (!cutoffs.has(transfer.from)) cutoffs.set(transfer.from, transfer.after);
			yield undefined;
		}
		function transferContent(
			key: string,
			content: CompositionArtifact<ResolvedRun[]>
		): CompositionArtifact<ResolvedRun[]> {
			const input = sourceContents.get(key) ?? withIncoming(key, content);
			const cutoff = cutoffs.get(key);
			if (cutoff === undefined) return input;
			const version = JSON.stringify(['cutoff', key, input.id, cutoff]);
			return (
				request.get<ResolvedRun[]>(version) ??
				request.put(
					version,
					input.value.filter((run) => !belongsAfter(run, cutoff)),
					[input]
				)
			);
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
		function generatedContent(paragraph: GeneratedParagraph): CompositionArtifact<ResolvedRun[]> {
			const { block, atoms } = paragraph;
			const owner = patchAnnotation(paragraph.annotation);
			const targets = new Set(block.numbering ? [block.numbering.itemKey] : []);
			for (const atom of atoms)
				if (atom.kind === 'reference') {
					targets.add(atom.targetItemKey);
					if (atom.endTargetItemKey) targets.add(atom.endTargetItemKey);
				}
			const version = JSON.stringify([
				'generated',
				view,
				block,
				atoms,
				owner,
				[...targets].map((target) => [target, current.get(target)])
			]);
			const cached = request.get<ResolvedRun[]>(version);
			if (cached) {
				engine.reusedContainers++;
				return cached;
			}
			return request.put(version, [
				...numberPrefix(block.numbering, owner),
				...replacement(atoms, owner)
			]);
		}
		function resolved(
			version: unknown[],
			dependencies: readonly CompositionArtifact<object>[],
			create: () => ResolvedBlock
		): ResolvedBlock {
			// One-shot consumers have no cross-request block interning. Workspace requests
			// look up the complete semantic version before constructing resolved output.
			const key = request.owner ? JSON.stringify(['block', view, ...version]) : undefined;
			const cached = key ? request.get<ResolvedBlock>(key) : undefined;
			if (cached) {
				engine.reusedResolvedBlocks++;
				return cached.value;
			}
			engine.recomposedBlocks++;
			const block = create();
			return key ? request.put(key, block, dependencies).value : block;
		}
		function nonTable(
			block: Exclude<ContractBlock, { kind: 'table' }>,
			raw: CompositionArtifact<ResolvedRun[]>
		): ResolvedBlock {
			const input = transferContent(block.blockKey, raw);
			const promoted = structural.numberingOverrides.get(block.blockKey);
			const owner = promoted ? patchAnnotation(promoted.annotation) : undefined;
			const promotion = promoted
				? [promoted.numbering, owner, current.get(promoted.numbering.itemKey)]
				: undefined;
			const removed = structural.removed.has(block.blockKey);
			const role = structural.roles.get(block.blockKey) ?? block.role;
			const numbering = promoted?.numbering ?? block.numbering;
			const numberingDepth = numbering ? current.get(numbering.itemKey)?.tokens.length : undefined;
			return resolved(
				[
					block.blockKey,
					block.kind,
					block.anchor,
					role,
					numberingDepth,
					numbering?.continueSequence,
					input.id,
					promotion,
					removed,
					outgoing.get(block.blockKey) ?? []
				],
				[input],
				() => {
					let content = input.value;
					if (promoted && !block.numbering)
						content = [...numberPrefix(promoted.numbering, owner!), ...content];
					if (removed) content = content.map((run) => ({ ...run, revision: 'removed' as const }));
					content = trimAfterNumber(content);
					const boundary = index.structuralBoundaries.get(block.blockKey);
					return {
						kind: 'paragraph' as const,
						...(block.anchor ? { anchor: block.anchor } : {}),
						blockKey: block.blockKey,
						role: role === 'title' && numbering ? 'body' : role,
						...(numberingDepth ? { numberingDepth } : {}),
						...(numbering?.continueSequence === false ? { continueNumbering: false as const } : {}),
						content,
						...(boundary ? { boundariesAfter: [boundary] } : {})
					};
				}
			);
		}
		function* resolveBlock(block: ContractBlock): Generator<undefined, ResolvedBlock> {
			if (block.kind === 'table') return block;
			return nonTable(block, yield* composeContainer(index.containers.get(block.blockKey)!));
		}
		function* generatedAt(anchor: string): Generator<ResolvedBlock | undefined, void> {
			for (const paragraph of structural.generated.get(anchor) ?? []) {
				yield nonTable(paragraph.block, generatedContent(paragraph));
				yield undefined;
			}
		}
		yield* generatedAt('');
		for (const block of blocks) {
			const next = yield* resolveBlock(block);
			if (view !== 'effective' || !structural.removed.has(block.blockKey)) yield next;
			yield* generatedAt(block.blockKey);
		}
	}
}
