import type { DeepReadonly } from '../immutable';
import { semanticTarget } from './content';
import type { AuthoringInstructions, PlaybookItem, PlaybookItemId, SourceTarget } from './model';
import { newTriggerId } from './model';

export type PlaybookDraft = PlaybookItem & {
	instructions: AuthoringInstructions;
	persistedId?: PlaybookItemId;
};
export type ReadonlyDraft = DeepReadonly<PlaybookDraft>;

export function newPlaybookDraft(range: SourceTarget): PlaybookDraft {
	return {
		instructions: {},
		approvalPolicy: { kind: 'none' },
		trigger: { id: newTriggerId(), target: semanticTarget(range) },
		concessions: []
	};
}
