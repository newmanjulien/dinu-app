# Backend audit remediation

Scope: implement the eight-step plan at `/tmp/oceans-backend-audit-p286gcaw/final-plan.md`, authorized by the user's “go”. Local code and documentation only; no deployment, live conversion, new tests, or UI changes.

Baseline: current dirty workspace copied under `/tmp/oceans-backend-remediation/baseline`; SHA-256 inventory in `baseline.json`. Preserve independent support, lifecycle, buyer feedback and other changes.

## Decisions and limits

- Keep current ownership boundaries and durable IDs, replay inputs/results, draft formats, export acknowledgement aliases, privacy and cleanup lifetimes.
- Released intermediate query-client populations are unknown. Preserve a validated legacy/intermediate superset on unchanged routes, give current clients explicit V2 routes, and document retirement gates.
- Keep historical generation fallback and output mirrors until deployed clock/capture inventory proves retirement safe. Canonical manifest clocks must be authoritative.
- No browser or live acceptance. Use the required performance suite, backend type check and relevant existing compilation/integration checks after related changes. Do not add or weaken assertions.

## Progress

- R-01 (C-01/Q-01/Q-02): complete locally. Dedicated v1/v2 item/content validators, compatible unchanged buyer/seller routes, and explicit V2 current callers. Frozen public template geometry restores empty-release opening. The compatibility superset contains no seller instructions or unreleased bodies; original and intermediate clients retain their required fields. Both representations are checked at link/publication admission. Backend-first ordering and independent client/journal retirement documented in `docs/deployment.md`.
- R-02 (M-01): complete. Receipt slices advance past a bisected surrogate pair without changing raw inputs/results or the total admission envelope. Each non-final chunk advances at least 48 Ki code units, so the original maximum still requires at most 63 chunks; each chunk is at most 48 Ki + 1 code units. The existing 64-row read sentinel remains. This is source arithmetic, not native boundary certification.
- R-03 (Q-03/P-03/S-04): complete. Newest indexed native and legacy proposal revisions compete independently; overlap rejects identity/ownership/text/prefix disagreement. Exact-revision dedup remains separate. Authorized replay uses the already joined aggregate before any normalization. Changed saves still normalize through `patchContract`. Native/legacy decode shares one resolved wrapper, retaining broader runtime legacy choices/descriptions/tiers and provenance ownership checks.
- R-04 (S-01): complete to the compatibility gate. One validated manifest-first generation rule serves observations, authoring validation, saves, source repair and migration captures/finish. Mirror equality no longer gates canonical readiness. Missing historical fields still fall back; mirrors remain output-only until deployed manifest/capture/watermark evidence supports removal. No deployed inventory or reconciliation performed.
- R-05 (P-01/P-02): complete. The explicit template resolver sanitizes targets, instructions, review metadata and each concession once. Domain no-op identity/freeze guards remain. Editor review IDs and opening gutter read raw metadata without replacement-tree copies. RepWorkspace derives resolved templates from the immutable snapshot once and reuses them for initial source and proposal merges; no global cache added.
- R-06 (S-02/M-02): complete. Unreferenced booking failure-basis index removed; other admission fences remain. Each successful operator-resolution branch writes the same evidence once, with terminal proof validation/revision clocks/recovery scheduling preserved.
- R-07 (S-03): complete. Removed unused guard, plain reexports, returned reader member and provenance shim. Existing provenance fixture imports the owner directly; assertions unchanged. Kept the still-used `DeepReadonly` type and all registered export/journal aliases. Regenerated only API import/module blocks through the installed Convex template, preserving component declarations and the starting registration order; final generated delta is exactly two shim-registration deletions.
- R-08 (S-05): complete. Normal and late company-cleanup phases share one company-index drain using the caller's existing transaction budget, order and short-circuit behavior. Both invocations and all lifetimes remain.
- Validation and final source review: complete; evidence below.

## Validation performed

Logs are under `/tmp/oceans-backend-remediation`.

- `npx tsc --project src/convex/tsconfig.json --noEmit`: passed after final source changes (`backend-types-final.log`).
- `npm run test:perf`: 37/37 across seven files after final saving changes (`perf-final.log`). Existing assertions retain no-op/replay no-write behavior, stale/foreign selection refusal, creation/capture/rollback bounds, shared cache identity and scheduler cancellation/order. No assertion was weakened.
- `npm run test:hubspot`: 60/60 across five files (`hubspot.log`). Existing assertions cover replay/rollback, captured destinations, ownership/stale claims, export acknowledgement/retention, provenance and journal behavior.
- `npx vitest run --config vitest.lifecycle.config.ts loading-recovery.test.ts`: 5/5 (`loading-recovery.log`), preserving subscription identity, deadlines/retry and late-response disposal through the explicit V2 buyer route.
- `npm run build`: passed after final source changes (`build-final.log`), including frontend/Svelte/tools checks and production bundles; zero Svelte errors/warnings.
- `git diff --check`: passed. Source review compared changes against the starting dirty workspace, checked retained old caller field use and removed-helper references. The only test edits are existing fixture query/import paths; no new tests or expanded coverage.

## Remaining release qualification

- Unknown old/intermediate client populations require the retained superset. Duplicated choice fields consume the existing 4 MB mutable response allowance; effective content capacity may be lower. Inventory served/open clients and measure actual publication headroom before release, then retire intermediate fields under an explicit policy.
- Inventory/reconcile deployed manifest clocks, pointer mirrors, acknowledged watermarks and older active migration captures before rollout; mirror removal remains gated. Restart incompatible captures through the existing bounded certification process, preserving version/source/fingerprint fences.
- Mixed native/legacy proposal histories, maximum receipt Unicode boundaries, legacy query clients and old deletion-worker recovery were source-reviewed, not newly exercised by existing fixtures. Their runtime guarantees remain unverified.
- No full SSR/lifecycle run or browser/clipboard acceptance was performed. Separate workspace changes and historical full-suite failures are not certified by the targeted successful fixture or build.
- No deployment, live conversion/retirement, provider action, native limit/OCC/index rehearsal or database reset occurred. Follow `docs/deployment.md` for the isolated snapshot rehearsal and retained IDs/drafts/journal checks before release.
