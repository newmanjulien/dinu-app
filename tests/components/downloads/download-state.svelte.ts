import { vi } from 'vitest';
import { documentFixture, readyContract } from '../../support/document';

export function downloadState() {
	const ready = readyContract(documentFixture(0));
	const state = $state({
		auth: { authenticated: true },
		session: { blocked: false, transportGeneration: 0, closing: false },
		runtime: { paused: false },
		persistence: {
			confirmed: ready.contract,
			choices: {},
			pending: false,
			deleted: false,
			conflict: false,
			error: null,
			workBlock: null,
			blockedReason: null,
			editable: true,
			recoveryPending: false,
			selectionLimitError: null
		}
	});
	const savePending = vi.fn(async () => true);
	const editor = {
		id: ready.id,
		readable: ready,
		currentReady: true,
		metadata: ready.contract,
		persistence: state.persistence,
		items: [],
		renderChoices: {},
		definitionsReady: true,
		documentInput: { kind: 'records' },
		buyerName: null,
		requestDelivery: null,
		notice: null,
		pending: false,
		savePending
	};
	return { state, ready, editor, savePending };
}
