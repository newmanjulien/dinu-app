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
	address: string;
	label: string;
	tokens: string[];
	pattern: NumberPatternPart[];
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
	blocks: readonly Pick<ContractBlock, 'numbering'>[]
): Generator<undefined, Map<string, Address>> {
	const result = new Map<string, Address>();
	const positions = new Map<string, number>();
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
		const labelPattern = item.labelPattern;
		const label = format(labelPattern);
		const address = item.referencePattern
			? { pattern: item.referencePattern, address: format(item.referencePattern) }
			: itemAddress(parent, labelPattern, label);
		positions.set(item.sequenceKey, position);
		result.set(item.itemKey, {
			label,
			tokens: values,
			...address
		});
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
	for (const [pattern, target] of [
		[atom.display.start, first],
		[atom.display.end, last]
	] as const)
		if (target) {
			if (!pattern) throw new PlaybookValidationError('Missing reference display.');
			validateNumberPattern(pattern, target.tokens.length, true);
		}
	return (
		formatNumberPattern(atom.display.start, first.tokens) +
		(last ? atom.display.separator + formatNumberPattern(atom.display.end!, last.tokens) : '')
	);
}
