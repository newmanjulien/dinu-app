import { dev } from '$app/environment';
import { env } from '$env/dynamic/public';

type Phase =
	| 'click'
	| 'confirmed'
	| 'snapshot-ready'
	| 'navigation-start'
	| 'navigation-end'
	| 'displayed'
	| 'failed';
type Trace = { phases: Partial<Record<Phase, number>> };
let current: Trace | undefined;
const traces: Trace[] = [];

/** Bounded, local timings only: never record names, IDs, or document content. */
export function beginCreation() {
	if (!dev && env.PUBLIC_DOCUMENT_PERF !== '1') return;
	current = { phases: { click: performance.now() } };
	traces.push(current);
	if (traces.length > 100) traces.shift();
	Object.assign(window, { __contractCreationTimings: traces });
}
export function creationPhase(phase: Phase) {
	// 'displayed' marks the first exact mounted DOM, before complete interaction or physical paint.
	if (current && current.phases[phase] === undefined) current.phases[phase] = performance.now();
}
