import { contractItemId, type ContractItemId } from './item-identity';
import { v, type Infer } from 'convex/values';
import type { ApplicationChoices } from './applications';
export const activityCommand = v.object({
	id: v.string(),
	itemId: contractItemId,
	choice: v.union(
		v.object({ concessionId: v.string(), applicationId: v.optional(v.string()) }),
		v.null()
	),
	occurredAt: v.number()
});
export type ActivityCommand = Infer<typeof activityCommand>;
export const MAX_ACTIVITY_COMMANDS = 250;
export const MAX_SAVE_COMMANDS = 25;
export function projectCommands(
	base: ApplicationChoices,
	commands: readonly ActivityCommand[]
): ApplicationChoices {
	const next = { ...base };
	for (const command of commands) {
		if (command.choice) next[command.itemId] = command.choice;
		else delete next[command.itemId];
	}
	return next;
}
