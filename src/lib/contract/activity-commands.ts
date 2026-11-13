import type { PlaybookCommand, PlaybookState } from './changes';
export { MAX_SAVE_COMMANDS } from './changes';
export type ActivityCommand = PlaybookCommand;
export const MAX_ACTIVITY_COMMANDS = 250;
export type PlaybookIntent = Record<string, PlaybookCommand['action']>;

export function currentHead(base: readonly PlaybookState[], itemId: string) {
	return base.find((item) => item.itemId === itemId)?.currentChangeId ?? null;
}

/** Every command for a widget compares its original head, even within one ordered batch. */
export function commandsMatch(
	base: readonly PlaybookState[],
	commands: readonly PlaybookCommand[]
) {
	return commands.every(
		(command) => currentHead(base, command.itemId) === command.expectedCurrentChangeId
	);
}

/** Local intent records effects, never predicted server change or approval identities. */
export function projectCommands(commands: readonly PlaybookCommand[]): PlaybookIntent {
	return Object.fromEntries(commands.map((command) => [command.itemId, command.action]));
}

export function selectedOptions(base: readonly PlaybookState[], intent: PlaybookIntent) {
	const choices: Record<string, string> = {};
	for (const item of base)
		if (item.currentOptionId !== null) choices[item.itemId] = item.currentOptionId;
	for (const [itemId, action] of Object.entries(intent)) {
		const optionId =
			action.kind === 'set'
				? action.optionId
				: base.find((item) => item.itemId === itemId)?.appliedOptionId;
		if (optionId != null) choices[itemId] = optionId;
		else delete choices[itemId];
	}
	return choices;
}
