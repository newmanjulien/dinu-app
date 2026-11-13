# Publication/version audit remediation

User authorized implementation of the eight-step audit plan with “go”.
Plan: `/tmp/oceans-version-audit-20261111-mVm7kR/final-plan.md`.
Baseline copies: `/tmp/oceans-version-remediation-20261111/before/`. Existing dirty work is preserved.

Scope: R01 capability adoption; R02 one version-bound recovery owner across route aliases; R03 stable history access; R04 explicit backend acquisition; R05 conditional explanations; R06 derive buyer revision; R07 shared bounded reader; R08 retire unused codec. Preserve version/publication rules and UI. Local work only; no deployment or migration. No new tests or browser checks.

Status: complete. R01–R08 implemented and locally validated. No deployment or migration executed.

- R01: ordered live metadata seals editing at equal working counters; receipts cannot reopen it. Only retained requests can reconcile a sealed version.
- R02: account registry owns one persistence/journal per resolved version; route views keep their own subscriptions. Recovery discovery uses the checkpoint base version. Historical views never write the latest snapshot cache. Legacy checkpoints transfer only after durable versioned storage; malformed/conflicting records stay blocked. Save owners never change version; the default view switches owners after old work is resolved/discarded.
- R03: history lifetime follows primitive access fields and client/retry, with paged reads captured under that same lifetime.
- R04: shared version access acquires no content/working/integration rows. Discussion metadata/markSeen use it; content writes/proposals still acquire and validate wording. Approved seller content and seller history avoid mutable child joins. Candidate content acquires only working state; proposal mutations reuse their already authorized full contract for integration policy and writes. Narrow content-helper parameter types preserve document validation. Removed the unused `inputs` alias.
- R05: public projection-only routes omit explanation acquisition; full content routes explicitly acquire it. Annotation hiding retains necessary reads and reader caches.
- R06: stored version number is the sole authority; buyer revision DTOs/stale checks derive it. Updated only the affected perf fixture shape. No deployed-data compatibility verified.
- R07: active buyer-change reads share their original bound and index; caller-specific overflow messages remain.
- R08: removed the unused tuple provenance codec and only its two codec-specific tests. Current export/document/retention assertions and historical chunk cleanup remain. API declarations regenerated locally using the installed Convex generator, preserving component declarations; no remote generation or deployment.

Final validation:

- `npm run test:perf`: 39/39 passed. Existing bounded saving, snapshot/cache and scheduling assertions retained; only the retired stored revision field was removed from its affected fixture.
- `npx vitest run --config vitest.lifecycle.config.ts tests/lifecycle/contracts.test.ts`: 23/23 passed. Existing operation/application identity, account exits, transport replacement, late-response/discard, recovery concurrency and deletion checks retained. Journal assertions now read the owning version key; legacy checkpoint writes remain to exercise compatibility.
- `npm run test:hubspot`: 58/58 passed across five integration files, including the eight current export cases. Only the two tests solely covering the removed tuple codec were retired. Existing export/retention, security, delivery and activity assertions remain.
- `npx tsc --project src/convex/tsconfig.json --noEmit`: passed.
- `npm run build`: passed, including frontend/tools checks with zero errors and zero Svelte warnings, SSR/client builds and local Vercel adapter output. Log: `/tmp/oceans-version-remediation-20261111/build.log`.
- Scoped `git diff --check`: passed. Final symbol/caller review confirms the removed codec/storage field/unused alias have no remaining readers or writers; wire buyer revision names are retained.

Initial failures identified old journal lookup keys and the retired fixture field; the intended guarantees and assertions were preserved. No new test cases or browser checks were introduced. Source changes against this turn’s captured dirty-tree baseline are recorded in `/tmp/oceans-version-remediation-20261111/changes.json` (20 changed/removed implementation, generated and existing test files, plus this progress note).

Unverified: explicit/default alias timing, equal-counter sealing with late receipts, exact multi-user publication/proposal schedules and live picker behavior are not covered by new cases or browser checks. The existing integration suite does not directly exercise the new discussion/context endpoints. Generated export bytes, real provider dispatch, hosted query read savings, target database shape/legacy conversion and deployment compatibility were not checked. Stored `buyerRevision` removal needs target-data verification before a later deployment; no deployment or backfill was run. No measured traffic, latency or cost claim is made.
