import { CompositionArtifactStore } from '$lib/document/composition-artifacts';
import { DocumentCompositionEngine } from '$lib/document/compose';
import { ContractDocumentCompositionEngine } from '$lib/document/contract-compose';
import { LayoutPreparationEngine } from '../pagination/prepare';
import { iteratePanelSourceFacts, type PanelSourceFacts } from '../panel-source-facts';
import type { DocumentRenderSource } from './types';

/** Lifetime follows the workspace's accepted render source, independently of layout epochs. */
export class DocumentArtifacts {
	readonly composition = new CompositionArtifactStore();
	#lifetime = new AbortController();
	get signal() {
		return this.#lifetime.signal;
	}
	destroy() {
		this.#lifetime.abort();
		this.composition.destroy();
		this.#panelSourceFacts = undefined;
	}
	#panelSourceFacts?: PanelSourceFacts;
	get panelSourceFacts() {
		return this.#panelSourceFacts;
	}
	*preparePanelSourceFacts(): Generator<undefined, PanelSourceFacts | undefined> {
		if (this.signal.aborted) return;
		if (this.#panelSourceFacts) return this.#panelSourceFacts;
		const facts = yield* iteratePanelSourceFacts(this.source);
		if (!this.signal.aborted) this.#panelSourceFacts ??= facts;
		return this.#panelSourceFacts;
	}
	readonly #preparation = new LayoutPreparationEngine();
	constructor(readonly source: DocumentRenderSource) {}
	compatible(source: DocumentRenderSource) {
		return (
			!this.signal.aborted &&
			this.source.sourceIndex === source.sourceIndex &&
			this.source.materialized?.document === source.materialized?.document &&
			this.source.materialized?.baseline === source.materialized?.baseline
		);
	}
	createPreparation() {
		return this.#preparation.fork();
	}
	createComposer() {
		if (this.source.materialized)
			return new ContractDocumentCompositionEngine(
				this.source.materialized.document,
				this.source.materialized.baseline,
				this.source.sourceIndex,
				this.composition
			);
		return new DocumentCompositionEngine(
			this.source.blocks,
			this.source.sourceIndex,
			this.composition
		);
	}
}
