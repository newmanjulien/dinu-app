import { CompositionArtifactStore } from '$lib/document/composition-artifacts';
import { DocumentCompositionEngine } from '$lib/document/compose';
import { LayoutPreparationEngine } from '../pagination/prepare';
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
	}
	readonly #preparation = new LayoutPreparationEngine();
	constructor(readonly source: DocumentRenderSource) {}
	createPreparation() {
		return this.#preparation.fork();
	}
	createComposer() {
		return new DocumentCompositionEngine(
			this.source.blocks,
			this.source.sourceIndex,
			this.composition
		);
	}
}
