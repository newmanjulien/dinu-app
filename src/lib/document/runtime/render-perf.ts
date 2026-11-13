import { dev } from '$app/environment';
import { env } from '$env/dynamic/public';
import { describeDestination } from '$lib/auth/routes';
import type { DocumentDomain } from '../domain/document-domain';
import type { LayoutProfileMetrics } from '../pagination/profiler';

const enabled = () => dev || env.PUBLIC_DOCUMENT_PERF === '1';

type OverlayWork =
	| 'measuredPages'
	| 'measuredNodes'
	| 'geometryNotifications'
	| 'selectionUpdates'
	| 'highlightPublications'
	| 'hoverChecks'
	| 'floatingUpdates';

/** Fixed aggregate counters; inspecting idle work does not retain DOM or callback references. */
export function countOverlayWork(name: OverlayWork, count = 1) {
	if (!enabled() || typeof window === 'undefined') return;
	const target = window as typeof window & {
		__documentOverlayPerf?: Partial<Record<OverlayWork, number>>;
	};
	const counters = (target.__documentOverlayPerf ??= {});
	counters[name] = (counters[name] ?? 0) + count;
}

type SearchWork =
	| 'refreshes'
	| 'scannedCharacters'
	| 'rangeResolutions'
	| 'materializedRanges'
	| 'measuredNodes'
	| 'rangeMeasurements';

/** Search counters retain only totals, never queries, ranges, or text nodes. */
export function countSearchWork(name: SearchWork, count = 1) {
	if (!enabled() || typeof window === 'undefined') return;
	const target = window as typeof window & {
		__documentSearchPerf?: Partial<Record<SearchWork, number>>;
	};
	const counters = (target.__documentSearchPerf ??= {});
	counters[name] = (counters[name] ?? 0) + count;
}

/** Opening milestones only; DOM readiness is not a physical paint measurement. */
export interface PanelOpenPerfSample {
	at: number;
	admissionMs?: number;
	accepted?: 0 | 1;
	admittedAt?: number;
	positionRequestedAt?: number;
	domReadyAt?: number;
	lookupMs?: number;
	geometryMs?: number;
	heldPosition?: 0 | 1;
	preparedSourceFacts?: 0 | 1;
	effective?: 0 | 1;
	resolvedAt?: number;
	contentMountedAt?: number;
}
export function createPanelOpenSample(): PanelOpenPerfSample | undefined {
	if (!enabled() || typeof window === 'undefined') return;
	const target = window as typeof window & { __documentPanelOpenPerf?: PanelOpenPerfSample[] };
	const samples = (target.__documentPanelOpenPerf ??= []);
	const sample: PanelOpenPerfSample = { at: performance.now() };
	samples.push(sample);
	if (samples.length > 100) samples.shift();
	return sample;
}

/** Includes admission becoming available after rendering/preparation; retains numbers only. */
export function recordPanelReadiness(ready: boolean) {
	if (!enabled() || typeof window === 'undefined') return;
	const target = window as typeof window & {
		__documentPanelReadiness?: { at: number; ready: 0 | 1 }[];
	};
	const samples = (target.__documentPanelReadiness ??= []);
	samples.push({ at: performance.now(), ready: ready ? 1 : 0 });
	if (samples.length > 100) samples.shift();
}

/** Aggregate template editor lifetime counters; no departed component or query references. */
function templateQueryCounters() {
	if (!enabled() || typeof window === 'undefined') return;
	const target = window as typeof window & {
		__templateQueryPerf?: {
			activeOwners: number;
			mounts: number;
			unmounts: number;
			sourceUpdates: number;
		};
	};
	return (target.__templateQueryPerf ??= {
		activeOwners: 0,
		mounts: 0,
		unmounts: 0,
		sourceUpdates: 0
	});
}
export function recordTemplateQueryOwner() {
	const counters = templateQueryCounters();
	if (!counters) return;
	counters.activeOwners++;
	counters.mounts++;
	return () => {
		counters.activeOwners--;
		counters.unmounts++;
	};
}
export function recordTemplateSourceUpdate() {
	const counters = templateQueryCounters();
	if (counters) counters.sourceUpdates++;
}

/** Local, bounded navigation milestones; timestamps use the browser time origin. */
export function recordColdStart(name: string, startedAt?: number) {
	if (!enabled() || typeof window === 'undefined') return;
	const at = performance.now();
	const target = window as typeof window & {
		__documentColdStart?: { name: string; at: number; durationMs?: number }[];
	};
	const marks = (target.__documentColdStart ??= []);
	marks.push({ name, at, durationMs: startedAt === undefined ? undefined : at - startedAt });
	if (marks.length > 100) marks.shift();
}

/** DOM flush durations, separate from geometry preparation and scheduler wait time. */
export function recordPageMount(
	generation: number,
	startedAt: number,
	pageCount: number,
	atomic = false
) {
	if (!enabled() || typeof window === 'undefined') return;
	const target = window as typeof window & {
		__documentPageMountPerf?: {
			generation: number;
			at: number;
			durationMs: number;
			pageCount: number;
			atomic: boolean;
		}[];
	};
	const samples = (target.__documentPageMountPerf ??= []);
	samples.push({
		generation,
		at: startedAt,
		durationMs: performance.now() - startedAt,
		pageCount,
		atomic
	});
	if (samples.length > 100) samples.shift();
}

/** Bounded numeric windows, including awaited DOM flushes; never retain document content. */
export interface SchedulerWindowSample {
	at: number;
	budgetMs: number;
	durationMs: number;
	preparationCallbacks: number;
	appendedPages: number;
	preparationMs: number;
	mountMs: number;
	overruns: number;
}
export function recordSchedulerWindow(sample: SchedulerWindowSample) {
	if (!enabled() || typeof window === 'undefined') return;
	const target = window as typeof window & { __documentSchedulerPerf?: SchedulerWindowSample[] };
	const samples = (target.__documentSchedulerPerf ??= []);
	samples.push({ ...sample });
	if (samples.length > 100) samples.shift();
}

/** Home-scoped observation includes browser DOM work following background slices. */
export function observeHomeWarming(): () => void {
	if (!enabled() || typeof PerformanceObserver === 'undefined') return () => {};
	const target = window as typeof window & {
		__contractHomeWarmingPerf?: {
			startedAt: number;
			endedAt?: number;
			longTasksSupported: boolean;
			longTasks: { at: number; durationMs: number }[];
		}[];
	};
	const sample = {
		startedAt: performance.now(),
		endedAt: undefined as number | undefined,
		longTasksSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'),
		longTasks: [] as { at: number; durationMs: number }[]
	};
	const samples = (target.__contractHomeWarmingPerf ??= []);
	samples.push(sample);
	if (samples.length > 20) samples.shift();
	recordColdStart('home-warming-start');
	let observer: PerformanceObserver | undefined;
	const collect = (entries: readonly PerformanceEntry[]) => {
		for (const entry of entries) {
			sample.longTasks.push({ at: entry.startTime, durationMs: entry.duration });
			if (sample.longTasks.length > 100) sample.longTasks.shift();
		}
	};
	if (sample.longTasksSupported) {
		observer = new PerformanceObserver((list) => collect(list.getEntries()));
		observer.observe({ type: 'longtask' });
	}
	return () => {
		if (observer) collect(observer.takeRecords());
		observer?.disconnect();
		sample.endedAt = performance.now();
		recordColdStart('home-warming-end');
	};
}

let documentNavigation: { pathname: string; startedAt: number } | undefined;
export function recordDocumentNavigation(pathname: string, startedAt = performance.now()) {
	if (!enabled() || typeof window === 'undefined') return;
	if (!describeDestination(pathname).document) {
		cancelDocumentNavigation();
		return;
	}
	documentNavigation = { pathname, startedAt };
	recordColdStart('document-navigation-start');
}

export function cancelDocumentNavigation() {
	documentNavigation = undefined;
}

export function recordDocumentReady() {
	if (!enabled() || typeof window === 'undefined') return;
	const navigation = documentNavigation;
	if (!navigation || navigation.pathname !== window.location.pathname) return;
	recordColdStart(
		describeDestination(navigation.pathname).document === 'template'
			? 'template-navigation-to-document-ready'
			: 'contract-navigation-to-document-ready',
		navigation.startedAt
	);
	documentNavigation = undefined;
	return navigation.startedAt;
}

/** Fixed work categories: bounded counters, no source text or backend identifiers. */
type StartupWork = 'sourceAccept';
type StartupCount =
	'authoringAccept' | 'workspaceCreated' | 'rendererCreated' | 'profileSurfaceMount';
type StartupCounters = Partial<Record<StartupWork, { count: number; totalMs: number }>> &
	Partial<Record<StartupCount, { count: number }>>;

function startupCounters() {
	if (!enabled() || typeof window === 'undefined') return;
	const target = window as typeof window & { __contractStartupPerf?: StartupCounters };
	return (target.__contractStartupPerf ??= {});
}
export function measureStartupWork<T>(name: StartupWork, work: () => T): T {
	const counters = startupCounters();
	if (!counters) return work();
	const startedAt = performance.now();
	try {
		return work();
	} finally {
		const counter = (counters[name] ??= { count: 0, totalMs: 0 });
		counter.count++;
		counter.totalMs += performance.now() - startedAt;
	}
}
export function countStartupWork(name: StartupCount) {
	const counters = startupCounters();
	if (counters) (counters[name] ??= { count: 0 }).count++;
}

/** Fixed numeric work counters only; references let interactive queries update counts in place. */
export function recordDomainWork(domain: DocumentDomain) {
	if (!enabled() || typeof window === 'undefined') return;
	const target = window as typeof window & {
		__documentDomainPerf?: {
			ingestion: DocumentDomain['metrics'];
			geometry: NonNullable<DocumentDomain['geometry']>['metrics'] | undefined;
		};
	};
	target.__documentDomainPerf = { ingestion: domain.metrics, geometry: domain.geometry?.metrics };
}

export interface RenderPerfSample extends LayoutProfileMetrics {
	schedulerWaitMs: number;
	maxSchedulerWaitMs: number;
	maxCompositionSliceMs: number;
	maxTokenPreparationSliceMs: number;
	preparedArtifactsReused: number;
	containerArtifactsReused: number;
	resolvedArtifactsReused: number;
	panelSourcePrepareMs: number;
	panelSourcePreparationSlices: number;
	maxPanelSourcePreparationSliceMs: number;
	panelSourceFactsReused: number;
	panelSourcePreparationFailed: number;
	panelSourceReadyAt?: number;
	paginationRestartPage: number;
	paginationStopPage: number;
	generation: number;
	priority?: import('./scheduler').RenderPriority;
	sourceRevision: number;
	requestedAt: number;
	inputAt: number;
	renderStartedAt?: number;
	layoutEpoch?: string;
	compositionCompleteAt?: number;
	preparationCompleteAt?: number;
	paginationCompleteAt?: number;
	firstPageAt?: number;
	preparationSlices: number;
	maxPreparationSliceMs: number;
	paintOpportunityAt?: number;
	inputToPaintOpportunityMs?: number;
	visibleUpdateMs?: number;
	affectedContainers: number;
	blocksRecomposed: number;
	pagesReused: number;
	composeMs: number;
	prepareMs: number;
	profileResolveMs: number;
	paginateMs: number;
	reconcileMs: number;
	pagesChanged: number;
	pageCount: number;
	blocksProcessed: number;
	tokensProcessed: number;
	snapshotAt?: number;
	commitToDomMs: number;
	totalMs: number;
	settledTotalMs?: number;
	cancelled: boolean;
	failed: boolean;
}
let lastInputAt = 0;
export function recordDocumentInput(event: Event) {
	if (enabled()) lastInputAt = event.timeStamp;
}
export function createPerfSample(
	generation: number,
	sourceRevision: number
): RenderPerfSample | undefined {
	if (!enabled()) return;
	const requestedAt = performance.now();
	const inputAt = lastInputAt && requestedAt - lastInputAt < 1000 ? lastInputAt : requestedAt;
	lastInputAt = 0;
	return {
		generation,
		schedulerWaitMs: 0,
		maxSchedulerWaitMs: 0,
		maxCompositionSliceMs: 0,
		maxTokenPreparationSliceMs: 0,
		preparedArtifactsReused: 0,
		containerArtifactsReused: 0,
		resolvedArtifactsReused: 0,
		panelSourcePrepareMs: 0,
		panelSourcePreparationSlices: 0,
		maxPanelSourcePreparationSliceMs: 0,
		panelSourceFactsReused: 0,
		panelSourcePreparationFailed: 0,
		paginationRestartPage: 1,
		paginationStopPage: 0,
		maxProfileTransactionMs: 0,
		profileTransactionOverruns: 0,
		sourceRevision,
		requestedAt,
		inputAt,
		affectedContainers: 0,
		blocksRecomposed: 0,
		pagesReused: 0,
		composeMs: 0,
		prepareMs: 0,
		profileResolveMs: 0,
		preparationSlices: 0,
		maxPreparationSliceMs: 0,
		profileCacheHits: 0,
		profileCacheMisses: 0,
		profileUniqueMisses: 0,
		profileBatchCount: 0,
		profileDomUpdateMs: 0,
		profileReadMs: 0,
		profileTotalMs: 0,
		maxProfileBlockMs: 0,
		paginateMs: 0,
		reconcileMs: 0,
		pagesChanged: 0,
		pageCount: 0,
		blocksProcessed: 0,
		tokensProcessed: 0,
		commitToDomMs: 0,
		totalMs: 0,
		cancelled: false,
		failed: false
	};
}
// Bounded, opt-in inspection without production logging or reactive dependencies.
export function recordPerfSample(sample?: RenderPerfSample) {
	if (!enabled() || !sample || typeof window === 'undefined') return;
	const target = window as typeof window & { __documentRenderPerf?: RenderPerfSample[] };
	const samples = (target.__documentRenderPerf ??= []);
	const index = samples.findIndex(
		(value) => value.generation === sample.generation && value.requestedAt === sample.requestedAt
	);
	if (index < 0) samples.push({ ...sample });
	else samples[index] = { ...sample };
	if (samples.length > 100) samples.shift();
}
