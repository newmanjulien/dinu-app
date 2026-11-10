import { getContext, setContext } from 'svelte';
import { DocumentScheduler } from './scheduler';
import type { LayoutProfiler, LayoutProfileSurface } from '../pagination/profiler';
const LAYOUT_PROFILES = Symbol('document-layout-profiles');
/** One live browser/font environment. Contains geometry only, never a view snapshot. */
export class DocumentLayoutProfiles {
	private implementation = $state.raw<typeof LayoutProfiler>();
	constructor(readonly scheduler = new DocumentScheduler()) {}
	install(Profiler: typeof LayoutProfiler) {
		this.implementation = Profiler;
	}

	surface = $state.raw<LayoutProfileSurface>();
	profiler = $derived.by(() =>
		this.surface && this.implementation
			? new this.implementation(this.surface, undefined, this.scheduler)
			: undefined
	);
}
export function setDocumentLayoutProfiles(profiles: DocumentLayoutProfiles) {
	return setContext(LAYOUT_PROFILES, profiles);
}
/** Embedded viewers and the rollout fallback keep their own fresh profiling surface. */
export function getDocumentLayoutProfiles(): DocumentLayoutProfiles | undefined {
	return getContext(LAYOUT_PROFILES);
}
