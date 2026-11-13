# Document loading implementation

Scope: approved `document-loading-plan.md`; no backend or UI redesign. Preserve existing unrelated workspace changes. Baseline copies of lib/tests/docs are in `/tmp/oceans-document-loading-implementation/baseline`.

Implemented: dynamic destination warming; template opening/source ownership; saved-flight capture/navigation reservation; early contract-local definitions and atomic complete inputs; global font gate removal; buyer code/status overlap. No backend changes.

Existing fixtures now deliver source and selected definitions through their actual owners. No new tests or weakened assertions. Saved view transfer preserves one mounted owner, and an early opening failure transfers without automatic retry; Create → saved explicitly retries when requested. Superseded/failed navigation releases its download consumer without canceling other consumers of the frozen version. Committed navigation can keep its consumer while host/editor code loads. Save-only recovery does not resolve document records or subscribe to selected definitions.

Final validation:

- `npm run test:lifecycle`: 92/92 lifecycle tests and 12/12 SSR tests passed. Existing assertions cover Home interaction pause, editor/draft retention and recovery, access withdrawal, retained rendering and creation adoption.
- `npm run build`: passed, including Svelte/type/tool checks (zero errors and warnings) and production adapter output.
- `npm run verify:loading-bundles`: passed; public frame, Contracts and buyer entry keep their static heavy-dependency boundaries.
- `npm run test:perf`: final run 36/37 passed. Caching, saving, creation and scheduling checks passed. The remaining failure is `tests/perf/csm-provider.test.ts:138`: it expects rep support availability to reject. Since implementation started, a concurrent edit to `src/convex/csmBookings.ts` changed `assertDisplayAccess` to require admin only for setup and permits rep support. This implementation changed no backend files or that assertion. Earlier full runs passed 37/37 before that concurrent policy edit.
- `git diff --check`: passed.

Browser timing, real event/network handoff, unrelated-font behavior, native selection and pixels remain unverified, for the user's manual checks. No measured speedup is claimed. No browser checks or deployments were performed. Evidence/logs and baseline-relative patch: `/tmp/oceans-document-loading-implementation`.

Post-audit remediation is implemented; see [its progress record](document-loading-remediation.md).
All six accepted findings are addressed: cold wording retry uses the existing opening reset;
established navigation reservations survive repeated capture; final detach empties editor
projection caches; readiness is shared; the scope alone configures/destroys the template
source; and independent route/mounted template read leases replace their ownership mirror.
The existing font policy is unchanged.

Fresh remediation checks all passed: 37 performance tests, 92 lifecycle tests, 12 SSR tests,
production build/type/tool checks (zero Svelte errors/warnings), loading-bundle boundaries,
affected source/fixture formatting and `git diff --check`. This supersedes the historical
36/37 performance result above. The same real-browser and measurement limits still apply;
existing mocks do not certify cold-local retry, actual navigation overlap or heap release.
