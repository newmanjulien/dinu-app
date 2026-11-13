# Lifecycle remediation

- Scope: implement the approved plan for loading fixtures, Home setup context, buyer pending-header/API expectations, and buyer-link retries. Preserve unrelated working changes and approved copy feedback. No new tests or browser checks.
- Approved decisions: keep the generic pending buyer header while preserving private-content protection; match ensureLatest's current arguments without operationId. Permanent-link uniqueness remains a backend responsibility.
- Repairs: supply route params, render the role harness header, opt Home into deferred setup context without adding a Convex dependency to other shared-harness users.
- Retry requirement: fresh request after timeout, same captured arguments, cache late success without automatic clipboard writes; stale failures cannot clear newer work or an accepted link.
- Existing evidence: tests/ssr/loading.test.ts; tests/lifecycle/{contracts,workspace-role,home-snappiness,loading-recovery}.test.ts; src/lib/buyer/links.svelte.ts.
- Validation planned: SSR and focused lifecycle tests, then npm run verify. Run test:perf separately if verification stops before it. Distinct network completion orderings require source review; real browser positioning, clipboard activation, and setup fetching/prompt admission remain unverified.
- Implementation: completed initial fixture/assertion repairs and fresh-request retries with completion guards. Existing source review confirms the shared feedback host, offset, and timing are untouched.
- Fixture follow-up: the first focused run exposed missing ResizeObserver in jsdom. Added the existing suite's no-op observer pattern without changing assertions; focused rerun passed 42/42. Formatting and whitespace checks pass.
- Final validation: npm run verify exited 0. SSR 12/12, lifecycle 92/92 (including viewer fixtures), perf 37/37, HubSpot 60/60 passed. Svelte check: 0 errors and 0 warnings. Tool type checks, production build, and loading dependency boundaries all passed.
- Source-reviewed completion guards: only the current capture accepts successes; only its latest request may clear a failed capture, and never after any request has supplied a link. Destroy clears the capture. Timed-out waiters cannot reach the clipboard on late resolution. Approved feedback controller-to-host path and 2500/5000 ms timers remain intact.
- Logs: /tmp/lifecycle-remediation-{ssr,focused,verify}.log. No browser checks, new tests, backend edits, or deployments. Unverified: real clipboard activation and visual positioning, setup fetching/prompt admission, and distinct-request completion orderings beyond source review.
- Status: complete; all planned implementation and existing automated checks passed.
