import { vi } from 'vitest';
import { documentFixture, readyContract } from '../../support/document';

export function downloadState() {
	const ready = readyContract(documentFixture(0));
	const expectedSource = {
		stateRevision: ready.contract.stateRevision,
		documentId: ready.contract.documentId,
		documentRevision: ready.contract.documentRevision,
		title: ready.contract.title,
		templateVersionId: ready.contract.templateVersionId
	};
	const state = $state({
		auth: { authenticated: true },
		session: { blocked: false, transportGeneration: 0, closing: false },
		runtime: { paused: false },
		status: { data: { canExport: true, expectedSource }, error: undefined as Error | undefined },
		persistence: {
			confirmed: ready.contract,
			choices: {},
			intent: {},
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
		currentDocumentReady: true,
		notice: null,
		pending: false,
		savePending,
		preparePreview: vi.fn(),
		focusPreview: vi.fn()
	};
	return { state, ready, editor, savePending };
}
