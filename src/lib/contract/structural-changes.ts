import type { AnnotationMembership } from '../playbook/document-overlay';
import type { ContractChange } from '../playbook/model';
import type { ContractBlock } from './model';
import { compareTargets, structuralBoundary, targetContainers } from './ranges';
import { hasMeaningfulReplacement } from './replacement-content';
import type { SourceIndex } from './source-index';
import { pointPosition } from './source-index';
import {
	isTextTarget,
	type ParagraphRole,
	type ReplacementAtom,
	type SourceTarget,
	textTarget
} from './source-model';

export type ReplacementAnnotation = {
	target: SourceTarget;
	effect?: AnnotationMembership;
	replacementOffset?: number;
};
export type ChangeOrigin = {
	change: ContractChange;
	origin?: { itemId: string; concessionId: string; changeIndex: number };
	/** Transient patches share the authored range, without carrying its whole replacement. */
	annotation: ReplacementAnnotation;
};
export interface GeneratedParagraph {
	block: Extract<ContractBlock, { kind: 'paragraph' }>;
	atoms: ReplacementAtom[];
	annotation: ReplacementAnnotation;
}
export interface StructuralPlan {
	changes: ChangeOrigin[];
	generated: Map<string, GeneratedParagraph[]>;
	removed: Set<string>;
	roles: Map<string, ParagraphRole>;
	aliases: Map<string, string>;
	numberingOverrides: Map<
		string,
		{ numbering: NonNullable<ContractBlock['numbering']>; annotation: ReplacementAnnotation }
	>;
	transfers: { from: string; to: string; after: number; before?: number }[];
	numberingBlocks: readonly ContractBlock[];
	replacementGroups: { annotations: ReplacementAnnotation[]; paragraphs: ReplacementAtom[][] }[];
}

export function replacementParagraphs(atoms: readonly ReplacementAtom[]): ReplacementAtom[][] {
	const result: ReplacementAtom[][] = [[]];
	for (const atom of atoms)
		if (atom.kind === 'paragraph-break') result.push([]);
		else result.at(-1)!.push(atom);
	return result;
}

/** Expand only while composing. Persisted concessions retain their two authored locations. */
export function planStructuralChanges(
	index: SourceIndex,
	blocks: readonly ContractBlock[],
	input: readonly ChangeOrigin[]
): StructuralPlan {
	const numberingBlocks: ContractBlock[] = [];
	const generatedByKey = new Map<string, GeneratedParagraph>();
	const merges = new Map<
		string,
		{ to: string; position: number; annotation: ReplacementAnnotation }
	>();
	const plan: StructuralPlan = {
		changes: [],
		generated: new Map(),
		removed: new Set(),
		roles: new Map(),
		aliases: new Map(),
		numberingOverrides: new Map(),
		transfers: [],
		numberingBlocks,
		replacementGroups: []
	};
	const add = (anchor: string, paragraph: GeneratedParagraph) => {
		const local = plan.generated.get(anchor) ?? [];
		local.push(paragraph);
		plan.generated.set(anchor, local);
		generatedByKey.set(paragraph.block.blockKey, paragraph);
	};
	function generated(
		owner: ChangeOrigin,
		atoms: ReplacementAtom[],
		paragraphIndex: number,
		template: ContractBlock['numbering'],
		role: ParagraphRole = 'body'
	): GeneratedParagraph {
		const key = `insert:${JSON.stringify([owner.origin ?? owner.change.target, paragraphIndex])}`;
		const numbering = template ? { ...template, itemKey: key } : undefined;
		if (numbering) delete numbering.start;
		return {
			block: {
				kind: 'paragraph',
				blockKey: key,
				order: 0,
				content: [],
				role,
				...(numbering ? { numbering } : {})
			},
			atoms,
			annotation: { ...owner.annotation, replacementOffset: 0 }
		};
	}
	// Source order determines paragraph order even when the second selection is earlier.
	for (const owner of [...input].sort((a, b) =>
		compareTargets(index, a.change.target, b.change.target)
	)) {
		const { change } = owner;
		const boundary = structuralBoundary(index, change.target);
		const containers = targetContainers(index, change.target);
		const paragraphs = replacementParagraphs(change.replacement);
		if (isTextTarget(change.target) && containers.length === 1 && paragraphs.length === 1) {
			plan.changes.push(owner);
			continue;
		}
		const annotations: ReplacementAnnotation[] = [];
		plan.replacementGroups.push({ annotations, paragraphs });
		if (boundary) {
			// Incomplete authoring previews are intentionally invisible; persisted items are rejected
			// by shared structural validation before template saving.
			if (!hasMeaningfulReplacement(change.replacement)) continue;
			const before = index.blocks.get(boundary.afterBlockKey);
			const after = boundary.nextBlockKey ? index.blocks.get(boundary.nextBlockKey) : undefined;
			const template =
				after?.kind === 'paragraph' && after.numbering && after.numbering.continueSequence !== false
					? after.numbering
					: before?.kind === 'paragraph' && before.numbering?.continueSequence !== false
						? before.numbering
						: undefined;
			for (const [i, atoms] of paragraphs.entries()) {
				const role =
					before?.kind !== 'table' &&
					before?.role === 'title' &&
					after?.kind !== 'table' &&
					after?.role === 'title'
						? 'title'
						: 'body';
				const paragraph = generated(owner, atoms, i, template, role);
				annotations[i] = paragraph.annotation;
				add(boundary.afterBlockKey, paragraph);
			}
			continue;
		}
		if (!isTextTarget(change.target))
			throw new Error(`Unknown structural boundary: ${change.target.afterBlockKey}`);
		const start = pointPosition(index, change.target.range.start),
			end = pointPosition(index, change.target.range.end);
		const used = Math.min(containers.length, paragraphs.length);
		let destinationPosition = start;
		for (const [i, container] of containers.entries()) {
			const body = container.units.filter((unit) => unit.kind !== 'number');
			const first = body[0] ?? container.units[0],
				last = body.at(-1) ?? container.units.at(-1)!;
			const from = Math.max(start, first.position),
				to = Math.min(end, last.position + last.length);
			if (i === used - 1) destinationPosition = from;
			const pointAt = (position: number, ending: boolean) => {
				const unit = ending
					? [...body].reverse().find((unit) => unit.position <= position)
					: body.find((unit) => unit.position + unit.length >= position);
				const resolved = unit ?? (ending ? last : first);
				return {
					sourceKey: resolved.sourceKey,
					offset: Math.max(0, Math.min(resolved.length, position - resolved.position))
				};
			};
			const patch: ChangeOrigin = {
				...owner,
				annotation: { ...owner.annotation, replacementOffset: 0 },
				change: {
					target: textTarget({ start: pointAt(from, false), end: pointAt(to, true) }),
					replacement: paragraphs[i] ?? []
				}
			};
			annotations[i] = patch.annotation;
			plan.changes.push(patch);
			if (i >= used) plan.removed.add(container.blockKey);
		}
		const last = containers.at(-1)!.blockKey;
		const lastBlock = index.blocks.get(last);
		const template =
			lastBlock?.numbering?.continueSequence === false ? undefined : lastBlock?.numbering;
		const role = containers.every((container) => {
			const block = index.blocks.get(container.blockKey);
			return block?.kind === 'paragraph' && block.role === 'title';
		})
			? 'title'
			: 'body';
		let destination = containers[used - 1].blockKey;
		if (used < containers.length) {
			for (const container of containers.slice(used))
				merges.set(container.blockKey, {
					to: destination,
					position: destinationPosition,
					annotation: annotations[used - 1]
				});
		}
		for (let i = containers.length; i < paragraphs.length; i++) {
			const paragraph = generated(owner, paragraphs[i], i, template, role);
			annotations[i] = paragraph.annotation;
			add(last, paragraph);
			destination = paragraph.block.blockKey;
		}
		if (destination !== last) plan.transfers.push({ from: last, to: destination, after: end });
	}
	if (!plan.generated.size && !plan.removed.size) {
		plan.numberingBlocks = blocks;
		return plan;
	}
	// A suffix may itself receive a later merge. Prepare those sources first; two splits
	// in the same source paragraph each receive only their own part of its suffix.
	plan.transfers.sort(
		(a, b) =>
			index.containers.get(b.from)!.units[0].position -
				index.containers.get(a.from)!.units[0].position || a.after - b.after
	);
	const transfersBySource = new Map<string, StructuralPlan['transfers']>();
	for (const [i, transfer] of plan.transfers.entries()) {
		const next = plan.transfers[i + 1];
		if (next?.from === transfer.from) transfer.before = next.after;
		const local = transfersBySource.get(transfer.from) ?? [];
		local.push(transfer);
		transfersBySource.set(transfer.from, local);
	}
	function destinationAt(key: string, position: number): string {
		for (;;) {
			const transfer = transfersBySource
				.get(key)
				?.findLast((transfer) => transfer.after <= position);
			if (!transfer) return key;
			key = transfer.to;
		}
	}
	for (const [from, merge] of merges) {
		const key = destinationAt(merge.to, merge.position);
		const destination = generatedByKey.get(key)?.block ?? index.blocks.get(key);
		const source = index.blocks.get(from);
		if (source?.kind !== 'paragraph' || destination?.kind !== 'paragraph') continue;
		const currentRole = plan.roles.get(key) ?? destination.role;
		plan.roles.set(key, currentRole === source.role ? currentRole : 'body');
	}
	// Resolve numbering after all selections, so chained merges and splits agree with
	// the paragraph that actually receives the replacement text.
	for (const block of blocks) {
		const merge = merges.get(block.blockKey);
		if (!merge || !block.numbering) continue;
		const key = destinationAt(merge.to, merge.position);
		const generated = generatedByKey.get(key);
		const destination = generated?.block ?? index.blocks.get(key)!;
		let numbering = destination.numbering ?? plan.numberingOverrides.get(key)?.numbering;
		if (!numbering) {
			numbering = block.numbering;
			if (generated) generated.block.numbering = numbering;
			else plan.numberingOverrides.set(key, { numbering, annotation: merge.annotation });
		}
		if (block.numbering.itemKey !== numbering.itemKey)
			plan.aliases.set(block.numbering.itemKey, numbering.itemKey);
	}
	const all: ContractBlock[] = [
		...(plan.generated.get('') ?? []).map((paragraph) => paragraph.block)
	];
	for (const block of blocks) {
		if (!plan.removed.has(block.blockKey)) {
			const override = plan.numberingOverrides.get(block.blockKey);
			all.push(
				override && block.kind !== 'table' ? { ...block, numbering: override.numbering } : block
			);
		}
		all.push(...(plan.generated.get(block.blockKey) ?? []).map((paragraph) => paragraph.block));
	}
	// Final membership follows surviving output order, after all role-changing merges.
	// Removed redline sources do not reopen or close the effective title prefix.
	let titlePrefix = true;
	for (const block of all) {
		if (block.kind === 'table') {
			titlePrefix = false;
			continue;
		}
		const role = plan.roles.get(block.blockKey) ?? block.role;
		if (role === 'title' && (!titlePrefix || block.numbering))
			plan.roles.set(block.blockKey, 'body');
		if (role !== 'title' || block.numbering) titlePrefix = false;
	}
	// Preserve each sequence's initial value without disturbing later explicit restarts.
	const originalFirst = new Map<string, ContractBlock>();
	for (const block of blocks)
		if (block.numbering && !originalFirst.has(block.numbering.sequenceKey))
			originalFirst.set(block.numbering.sequenceKey, block);
	const first = new Map<string, ContractBlock>();
	for (const block of all) {
		const numbering = block.numbering;
		if (!numbering) {
			numberingBlocks.push(block);
			continue;
		}
		const original = originalFirst.get(numbering.sequenceKey)!;
		const earliest = first.get(numbering.sequenceKey);
		let adjusted = block;
		if (!earliest) {
			first.set(numbering.sequenceKey, block);
			if (original.numbering?.start !== undefined && original.blockKey !== block.blockKey)
				adjusted = { ...block, numbering: { ...numbering, start: original.numbering.start } };
		} else if (block.blockKey === original.blockKey && numbering.start !== undefined) {
			const { start: _start, ...continued } = numbering;
			adjusted = { ...block, numbering: continued };
		}
		numberingBlocks.push(adjusted);
	}
	return plan;
}
