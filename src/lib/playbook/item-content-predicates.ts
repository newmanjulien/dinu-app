export { hasMeaningfulReplacement } from '../document/replacement-content';

export const PLAYBOOK_INSTRUCTION_KEYS = [
	'summary',
	'howToExplainToBuyers',
	'commonObjections',
	'negotiation'
] as const;

export type PlaybookInstructionKey = (typeof PLAYBOOK_INSTRUCTION_KEYS)[number];

export function isValidPlaybookId(value: string): boolean {
	return value.trim().length > 0 && value === value.trim();
}

export function isValidSourceOffset(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

export function isNonBlankText(value: string): boolean {
	return value.trim().length > 0;
}

export function hasRepItemContent(item: {
	instructions: Readonly<Record<string, string | undefined>>;
	approvalPolicy: { readonly kind: 'none' | 'required' };
	concessions: readonly unknown[];
}): boolean {
	if (item.approvalPolicy.kind === 'required' || item.concessions.length > 0) return true;
	return PLAYBOOK_INSTRUCTION_KEYS.some((key) => {
		const value = item.instructions[key];
		return typeof value === 'string' && isNonBlankText(value);
	});
}
