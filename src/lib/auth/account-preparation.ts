import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../convex/_generated/api';

type Viewer = FunctionReturnType<typeof api.accounts.viewer>;

/** Only a confirmed live result may provision missing state, once per transport. */
export class AccountPreparation {
	private generation = -1;
	initialize(viewer: Viewer | undefined, generation: number, initialize: () => Promise<unknown>) {
		if (
			viewer === undefined ||
			(viewer && !viewer.needsInitialization) ||
			generation === this.generation
		)
			return;
		this.generation = generation;
		return initialize();
	}
}
