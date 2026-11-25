import { MAX_PLAYBOOK_ITEMS } from '../playbook/limits';

export type ContractSaveRequest = {
	id: string;
	operationId: string;
	expectedStateRevision: number;
	selections: Record<string, string>;
};

export type ContractDraft = {
	version: 1;
	baseStateRevision: number;
	selections: Record<string, string>;
	request: ContractSaveRequest | null;
	conflict: boolean;
};

export function draftObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

const identifier = (value: unknown): value is string =>
	typeof value === 'string' && value.trim().length > 0 && value.length <= 200;

const natural = (value: unknown): value is number =>
	typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function validSelections(value: unknown): value is Record<string, string> {
	if (!draftObject(value)) return false;
	const entries = Object.entries(value);
	if (entries.length > MAX_PLAYBOOK_ITEMS) return false;
	for (const [k, v] of entries) {
		if (!identifier(k) || !identifier(v)) return false;
	}
	return true;
}

export function validDraftRequest(value: unknown, id: string): value is ContractSaveRequest {
	return (
		draftObject(value) &&
		Object.keys(value).every((key) =>
			['id', 'operationId', 'expectedStateRevision', 'selections'].includes(key)
		) &&
		value.id === id &&
		identifier(value.operationId) &&
		natural(value.expectedStateRevision) &&
		validSelections(value.selections)
	);
}

export function readDraft(value: unknown, id: string): ContractDraft | undefined {
	if (
		!draftObject(value) ||
		Object.keys(value).some(
			(key) => !['version', 'baseStateRevision', 'selections', 'request', 'conflict'].includes(key)
		)
	)
		return;
	if (
		value.version !== 1 ||
		!natural(value.baseStateRevision) ||
		!validSelections(value.selections) ||
		typeof value.conflict !== 'boolean' ||
		!(value.request === null || validDraftRequest(value.request, id))
	)
		return;
	return value as ContractDraft;
}
