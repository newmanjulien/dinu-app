import { PlaybookValidationError } from '../playbook/validation-error';
import type { ContractBlock, InlineAtom } from './model';
import {
	formatNumberPattern,
	validateNumberPattern,
	type NumberPattern,
	type NumberPatternPart
} from './number-pattern';
import { numberValue } from './number-token';

export type Address = {
	/** Effective graph metadata, including adapted patterns and resolved parent aliases. */
	numbering: NonNullable<ContractBlock['numbering']>;
	position: number;
	address: string;
	label: string;
	tokens: string[];
	pattern: NumberPatternPart[];
	/** Transient identity after a paragraph merge; stored reference targets stay unchanged. */
	redirectedTo?: string;
};

function itemAddress(
	parent: Address | undefined,
	pattern: NumberPattern,
	label: string
): Pick<Address, 'address' | 'pattern'> {
	const local = pattern.map((part) => ({ ...part }));
	const wrapped = parent && !/^[([]/u.test(label);
	const last = local.at(-1);
	if (last && 'text' in last) {
		last.text = wrapped ? last.text.replace(/[.):\s]+$/u, '') : last.text.replace(/\.$/u, '');
		if (!last.text) local.pop();
	}
	return {
		pattern: [
			...(parent?.pattern ?? []),
			...(wrapped ? [{ text: '(' }, ...local, { text: ')' }] : local)
		],
		address: wrapped
			? `${parent.address}(${label.replace(/[.):\s]+$/u, '')})`
			: `${parent?.address ?? ''}${label.endsWith('.') ? label.slice(0, -1) : label}`
	};
}

/** Sequences are counted in document order. A child address uses its parent's active address. */
export function numberAddresses(
	blocks: readonly Pick<ContractBlock, 'numbering'>[]
): Map<string, Address> {
	const iterator = iterateNumberAddresses(blocks);
	let next = iterator.next();
	while (!next.done) next = iterator.next();
	return next.value;
}

export function* iterateNumberAddresses(
	blocks: readonly Pick<ContractBlock, 'numbering'>[],
	aliases: ReadonlyMap<string, string> = new Map()
): Generator<undefined, Map<string, Address>> {
	const result = new Map<string, Address>();
	const positions = new Map<string, number>();
	const redirected = new Map<string, string[]>();
	for (const [from, to] of aliases) {
		const seen = new Set([from]);
		let target = to;
		while (aliases.has(target)) {
			if (seen.has(target)) throw new PlaybookValidationError('Cyclic paragraph merge.');
			seen.add(target);
			target = aliases.get(target)!;
		}
		const sources = redirected.get(target) ?? [];
		sources.push(from);
		redirected.set(target, sources);
		yield undefined;
	}
	for (const block of blocks) {
		const item = block.numbering;
		yield undefined;
		if (!item) continue;
		const parent = item.parentItemKey ? result.get(item.parentItemKey) : undefined;
		if (item.parentItemKey && !parent)
			throw new PlaybookValidationError(`Missing parent address: ${item.itemKey}`);
		const position = item.start ?? (positions.get(item.sequenceKey) ?? 0) + 1;
		let token = numberValue(item.style, position, item.alphabeticStyle === 'sequential');
		if (item.minimumDigits) token = token.padStart(item.minimumDigits, '0');
		const values = [...(parent?.tokens ?? []), token];
		const format = (pattern: NumberPattern) => formatNumberPattern(pattern, values);
		const originalDepth = Math.max(
			...item.labelPattern.map((part) => ('level' in part ? part.level : 0))
		);
		const depthChanged = originalDepth !== values.length;
		function adapt(pattern: NumberPattern): NumberPattern {
			if (!depthChanged) return pattern;
			const ancestor = pattern.findLastIndex(
				(part) => 'level' in part && part.level < originalDepth
			);
			return [
				...(ancestor >= 0 ? (parent?.pattern ?? []) : []),
				...pattern
					.slice(ancestor + 1)
					.map((part) => ('level' in part ? { ...part, level: values.length } : part))
			];
		}
		const labelPattern = adapt(item.labelPattern);
		const label = format(labelPattern);
		const address = item.referencePattern
			? { pattern: adapt(item.referencePattern), address: format(adapt(item.referencePattern)) }
			: itemAddress(parent, labelPattern, label);
		positions.set(item.sequenceKey, position);
		const resolved: Address = {
			numbering: {
				...item,
				...(parent ? { parentItemKey: parent.numbering.itemKey } : {}),
				labelPattern,
				...(item.referencePattern ? { referencePattern: adapt(item.referencePattern) } : {})
			},
			position,
			label,
			tokens: values,
			...address,
			...(depthChanged ? { redirectedTo: item.itemKey } : {})
		};
		result.set(item.itemKey, resolved);
		for (const key of redirected.get(item.itemKey) ?? [])
			result.set(key, { ...resolved, redirectedTo: item.itemKey });
	}
	return result;
}

export function referenceText(
	atom: Extract<InlineAtom, { kind: 'reference' }>,
	addresses: ReadonlyMap<string, Address>
): string {
	if (
		Boolean(atom.display.end) !== Boolean(atom.endTargetItemKey) ||
		Boolean(atom.display.separator) !== Boolean(atom.endTargetItemKey)
	)
		throw new PlaybookValidationError('Invalid reference display.');
	const first = addresses.get(atom.targetItemKey);
	const last = atom.endTargetItemKey ? addresses.get(atom.endTargetItemKey) : undefined;
	if (!first || (atom.endTargetItemKey && !last))
		throw new PlaybookValidationError('Unresolved reference.');
	if (atom.display.separator && !/^[ \t]*[-–—][ \t]*$/u.test(atom.display.separator))
		throw new PlaybookValidationError('Invalid reference range separator.');
	const startPattern = first.redirectedTo ? first.pattern : atom.display.start;
	const endPattern = last?.redirectedTo ? last.pattern : atom.display.end;
	for (const [pattern, target] of [
		[startPattern, first],
		[endPattern, last]
	] as const)
		if (target) {
			if (!pattern) throw new PlaybookValidationError('Missing reference display.');
			validateNumberPattern(pattern, target.tokens.length, true);
		}
	const start = formatNumberPattern(startPattern, first.tokens);
	if (
		!last ||
		(first.redirectedTo ?? atom.targetItemKey) === (last.redirectedTo ?? atom.endTargetItemKey)
	)
		return start;
	return start + atom.display.separator + formatNumberPattern(endPattern!, last.tokens);
}
