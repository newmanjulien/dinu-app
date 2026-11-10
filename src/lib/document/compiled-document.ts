import type { SourceBlock } from './source-model';
import { validateDocumentSource } from './validate-source';

/** Immutable source semantics only. Never owns layout, view intent, or DOM state. */
export class CompiledDocument {
	readonly index;
	readonly validateReference;
	constructor(readonly blocks: readonly SourceBlock[]) {
		const validated = validateDocumentSource(blocks);
		this.index = validated.index;
		this.validateReference = validated.validateReference;
	}
}
