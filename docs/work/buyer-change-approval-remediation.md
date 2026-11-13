# Buyer-change approval remediation

## Scope
Implement all nine groups in /tmp/oceans-buyer-approval-audit-20261111-_8qyy4zr/final-plan.md, authorized by user “go”. Preserve all agreed UI/workflows and unrelated working-tree changes. No new tests, browser, provider actions or DB wipe. No deployment assumed by this plan.

## Evidence and progress
- Audit: 14 accepted review findings (3 medium, 11 low), two bounded underlying causes.
- Starting-file copies for isolated review: /tmp/buyer-approval-remediation-s953zj7o
- R-01 semantic deletion boundaries: complete.
- R-02 exact completed-intent retirement: complete.
- R-03 safe passage join / structural index cache: complete.
- R-04 retained-state capacity: complete.
- R-05 shared normalization finalizer / source-only public read: complete.
- R-06 remove unused acceptance fields/index: complete.
- R-07 authorized definition snapshot and seeded reader cache: complete.
- R-08 avoid effective wording preparation without approvals: complete.
- R-09 current-root reads only during full reset: complete.

## Validation
Required existing perf suite plus frontend/backend type/build checks completed. No new or expanded tests. Runtime multi-user, timeout schedules, browser geometry, email and exports remain manual unless separately exercised. Removed-field schema requires compatible data before a future push; no migration or reset authorized.

## Implementation checkpoint
- Preserved semantic empty runs through numbered-prefix cleanup, including leading discarded slices.
- Added account/key/operation compare-and-retire and own-member private correlation; actual RPC settlement retires its captured operation even after timeout.
- Passage rendering/hit-testing shares a live thread join; provenance index is component-local and keyed by root/render/pages while rectangles refresh.
- Capacity excludes exactly superseded nonapproved rows; one finalizer handles both normalization branches and reads effective released source facts without rendering.
- Removed unused native fields/index; fixed metadata stays in resolved DTOs.
- One seller authorization per selected-definition query; reader registration validates ownership and charges each immutable acceptance once.
- No-approved review responses skip reader preparation; reset skips historical root reads while still patching every active row.

## Final verification and review
- `npm run test:perf`: 39 existing checks / 7 files pass. Existing saving, scheduling, caching and startup regression guarantees preserved; no assertions or fixtures changed.
- `npx tsc --project src/convex/tsconfig.json --noEmit`: pass.
- `npm run build`: pass, including Svelte/TypeScript (zero errors/warnings), tool type checks and production bundle. Corrected the geometry join's branded thread-ID type after the first diagnostic build.
- `git diff --check`: clean. Reviewed isolated starting-file diff against all nine remediation groups and their preservation constraints. No new/expanded tests or browser checks.
- Static traces retain exact source signatures on both normalization paths, private accepting-member correlation, captured operation arguments/identity fences, approved-ancestor reset, ownership/unique byte accounting, and frozen historical-ID loading.
- Browser hit geometry/focus/touch, timeout schedules, live role/preview transitions, multi-user approval/rollback/reset, emails and exports remain unverified by execution. Perf suite does not directly exercise these new interaction/state-machine paths.
- Backend/schema changes are local only. The removed-field schema needs compatible deployment data; no deployment, migration, wipe or external provider action performed.
- Check logs, isolated diff and per-file stats are retained alongside the starting-file copies above (`perf.log`, `backend-types.log`, `build-final.log`, `implementation.diff`, `change-stats.json`).
