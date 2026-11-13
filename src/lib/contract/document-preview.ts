import {
	applyDocumentChange,
	contractDocumentFromRenderTransport,
	prepareDocumentTransition,
	type DocumentChange
} from '../document/contract-document';
import type { FunctionReturnType } from 'convex/server';
import type { api } from '../../convex/_generated/api';
import type { ResolvedContractItem } from './items';
import type { PlaybookCommand } from './changes';

export type ApprovedContractDocument = FunctionReturnType<typeof api.contractDefinitions.current>;
export type PreviewBasis = FunctionReturnType<typeof api.contractDefinitions.previewBasis>;

/** This projection always starts and ends with authoritative approved text. */
export function prepareApprovedDocument(
	input: ApprovedContractDocument,
	items: ResolvedContractItem[]
) {
	const document = contractDocumentFromRenderTransport(input.document);
	const hidden = new Set(input.hiddenItemIds);
	const targets = new Map(input.projectedTargets.map((item) => [item.itemId, item]));
	return {
		document,
		items: items
			.filter((item) => !hidden.has(item._id))
			.map((item) => {
				const projected = targets.get(item._id);
				return projected
					? {
							...item,
							primary: { ...item.primary, target: projected.trigger },
							choices: item.choices.map((choice) => ({
								...choice,
								changes: choice.changes.map((change, index) => ({
									...change,
									target:
										projected.choices.find((value) => value.id === choice.id)?.targets[index] ??
										change.target
								}))
							}))
						}
					: item;
			})
	};
}

/** One active comparison uses the shared pure engine; it never supplies main-viewer input. */
export function previewContractDocument(input: {
	approved: ApprovedContractDocument;
	item: ResolvedContractItem;
	basis: PreviewBasis;
	action?: PlaybookCommand['action'];
}) {
	const { approved, basis, item, action } = input;
	if (
		basis.documentId !== approved.documentId ||
		basis.displayIdentity !== approved.displayIdentity
	)
		return null;
	const document = contractDocumentFromRenderTransport(approved.document);
	let patch: DocumentChange | null = null;
	if (!action)
		patch = basis.currentPatch ? (JSON.parse(basis.currentPatch) as DocumentChange) : null;
	else if (action.kind === 'set') {
		const option =
			action.optionId === null
				? null
				: item.choices.find((choice) => choice.id === action.optionId);
		if (action.optionId !== null && !option)
			throw new Error('This Playbook option is unavailable.');
		patch = prepareDocumentTransition(
			document,
			JSON.parse(basis.approvedChain) as DocumentChange[],
			option?.changes ?? [],
			`preview:${item._id}:${action.optionId ?? 'base'}`
		);
	}
	return {
		patch,
		approved: document,
		document: patch ? applyDocumentChange(document, patch) : document
	};
}
export type FocusedPreview = NonNullable<ReturnType<typeof previewContractDocument>>;
