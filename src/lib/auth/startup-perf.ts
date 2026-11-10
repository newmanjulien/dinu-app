import { browser, dev } from '$app/environment';
import { env } from '$env/dynamic/public';

type StartupMetric = { name: string; at: number; attemptId: number; duration?: number };
let attemptId = 0;
export function beginStartupAttempt() {
	attemptId++;
}
declare global {
	interface Window {
		__accountStartup?: StartupMetric[];
	}
}
const enabled = () => browser && (dev || env.PUBLIC_DOCUMENT_PERF === '1');
export function recordStartup(name: string, duration?: number) {
	if (!enabled()) return;
	const metrics = (window.__accountStartup ??= []);
	metrics.push({
		name,
		at: performance.now(),
		attemptId,
		...(duration === undefined ? {} : { duration })
	});
	if (metrics.length > 100) metrics.splice(0, metrics.length - 100);
	performance.clearMarks(`account:${name}`);
	performance.mark(`account:${name}`);
}

/** Two frames put background work after the newly admitted surface has painted. */
export function afterStartupPaint(callback: () => void) {
	let frame = requestAnimationFrame(() => {
		frame = requestAnimationFrame(callback);
	});
	return () => cancelAnimationFrame(frame);
}
