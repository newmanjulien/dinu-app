import type { SourceBlock } from './source-model';
import { validateDocumentSource } from './validate-source';
import { documentIndex, type ContractDocument } from './contract-document';
import { referenceFacts, validateReferenceFacts } from './validation-source';

/** Immutable source semantics only. Never owns layout, view intent, or DOM state. */
export class CompiledDocument {
	readonly index;
	readonly validateReference;
	constructor(
		readonly blocks: readonly SourceBlock[],
		document?: ContractDocument
	) {
		const validated = document
			? (() => {
					const index = documentIndex(document),
						facts = referenceFacts(index);
					return {
						index,
						validateReference: (ref: Parameters<typeof validateReferenceFacts>[1]) =>
							validateReferenceFacts(facts, ref)
					};
				})()
			: validateDocumentSource(blocks);
		this.index = validated.index;
		this.validateReference = validated.validateReference;
	}
}
