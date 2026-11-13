# Document-loading regression checks

Status: complete. Four cases across the three approved areas, using the existing suites and fixtures.

Scope: tests and fixture support plus the subscription churn exposed by the new check. Preserve the existing dirty workspace. No browser, new test framework, timing benchmarks or heap-release claim.

Checks:

- Cache: held immutable download survives repeated activation and superseded navigation cleanup beyond intent expiry; abandoned intent cancels and a later open downloads again.
- Editor: repeated readiness/input consumers add no scans; missing or mismatched selected wording withholds document items until all selected choices exist, including after a selection change.
- Template: overlapping route/mounted leases and both audiences use one shared source read, one structure read per audience, and release after the final owner.

Baseline: `/var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/oceans-loading-tests-9h8_cpdn/baseline`.

Found during validation: TemplateSource's arguments were recalculated for positive reader-count changes, replacing the active subscription with identical arguments. A boolean derived value now changes those arguments only when source availability or zero/nonzero demand changes. The strict no-churn assertion remains.

Validation:

- `npm run test:perf`: 39/39 passed across seven files. Reservation expiry uses fake timeout clocks; immutable reads, releases and disk writes are counted.
- `npm run test:lifecycle`: 94/94 passed across 13 files, plus 12/12 SSR cases. After the final fixture type correction, the affected contract suite passed again (25/25).
- `npm run check`: zero Svelte errors/warnings; tool type checks passed.
- Targeted Prettier check and `git diff --check`: passed. No existing assertions were weakened or removed.
- Four temporary Vite loader variants reintroduced each regression in memory without editing repository source: navigation expiry failed on premature cancellation; an uncached readiness getter failed on extra scans; bypassing the wording gate failed on premature readiness; count-dependent source arguments failed on an extra subscription. All four failed at the intended assertions. Configs and logs are in the baseline's parent directory alongside `implementation.patch`.

The checks certify cache-owner handoff, readiness/input gating and subscription ownership. Real Kit navigation, rendered retry interaction, heap release and perceived speed remain browser/manual checks. No browser check, production build or deployment was performed in this follow-up.
