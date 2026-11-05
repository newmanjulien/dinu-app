import { CompositionArtifactStore } from '$lib/contract/composition-artifacts';
import { ContractCompositionEngine } from '$lib/contract/compose';
import { LayoutPreparationEngine } from '../pagination/prepare';
import type { ContractRenderSource } from './types';

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
	constructor(readonly source: ContractRenderSource) {}
	createPreparation() {
		return this.#preparation.fork();
	}
	createComposer() {
		return new ContractCompositionEngine(
			this.source.blocks,
			this.source.sourceIndex,
			this.composition
		);
	}
}
