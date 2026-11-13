import {
	MAX_ACTIVITY_COMMANDS,
	MAX_SAVE_COMMANDS,
	type ActivityCommand
} from './activity-commands';
import { validContractState } from './persisted-values';
import type { ContractSaveRequest } from './persistence.svelte';
import type { ContractState } from './saved';

export type ContractDraft = {
	version: 10;
	commands: ActivityCommand[];
	base: ContractState;
	request: ContractSaveRequest | null;
	conflict: boolean;
};
export function draftObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
const identifier = (value: unknown): value is string =>
	typeof value === 'string' && value.trim().length > 0 && value.length <= 200;
export function validDraftCommands(value: unknown, limit: number): value is ActivityCommand[] {
	if (!Array.isArray(value) || value.length > limit) return false;
	const ids = new Set<string>();
	for (const c of value) {
		if (
			!draftObject(c) ||
			Object.keys(c).some(
				(key) => !['id', 'itemId', 'action', 'expectedCurrentChangeId', 'occurredAt'].includes(key)
			) ||
			!identifier(c.id) ||
			ids.has(c.id) ||
			!identifier(c.itemId) ||
			!(c.expectedCurrentChangeId === null || identifier(c.expectedCurrentChangeId)) ||
			typeof c.occurredAt !== 'number' ||
			!Number.isFinite(c.occurredAt) ||
			!draftObject(c.action) ||
			!(c.action.kind === 'withdraw'
				? Object.keys(c.action).length === 1
				: c.action.kind === 'set' &&
					Object.keys(c.action).every((key) => ['kind', 'optionId'].includes(key)) &&
					(c.action.optionId === null || identifier(c.action.optionId)))
		)
			return false;
		ids.add(c.id);
	}
	return true;
}
export function validDraftRequest(value: unknown, id: string): value is ContractSaveRequest {
	return (
		draftObject(value) &&
		Object.keys(value).every((key) => ['id', 'operationId', 'commands'].includes(key)) &&
		value.id === id &&
		identifier(value.operationId) &&
		validDraftCommands(value.commands, MAX_SAVE_COMMANDS) &&
		value.commands.length > 0
	);
}

/** Only the post-reset envelope can become a live journal owner. */
export function readDraft(value: unknown, id: string): ContractDraft | undefined {
	if (
		!draftObject(value) ||
		Object.keys(value).some(
			(key) => !['version', 'base', 'request', 'conflict', 'commands'].includes(key)
		)
	)
		return;
	if (
		value.version !== 10 ||
		!validContractState(value.base) ||
		typeof value.conflict !== 'boolean' ||
		!validDraftCommands(value.commands, MAX_ACTIVITY_COMMANDS) ||
		!(value.request === null || validDraftRequest(value.request, id))
	)
		return;
	const commands = value.commands;
	if (
		value.request &&
		!value.request.commands.every(
			(command, index) => JSON.stringify(command) === JSON.stringify(commands[index])
		)
	)
		return;
	return value as ContractDraft;
}
