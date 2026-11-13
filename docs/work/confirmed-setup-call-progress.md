# Confirmed setup-call messages

Scope: implement the approved confirmed-booking plan. Preserve unrelated working-tree changes. No new tests, browser checks, deployment, or live data operations.

Baseline of touched existing files: /var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/confirmed-setup-call-u7n679s8

Decisions:

- Persist coherent confirmed status, UID, dates, and evidence separately from provider sync.
- Deliver admin-only setupCall through the existing viewer; header never displays sync uncertainty.
- Cancellation persists until confirmed replacement/release. Scheduled reminder hides at call end; setup qualification survives.
- Preserve operation guards and proof fencing. Migrate only coherent evidence and unambiguous owned references; leave unresolved cases for review.
- Use additive storage compatibility during the transition; provide bounded operator reconciliation and a later cleanup step.

Completed: inspected booking proof, setup qualification, viewer, workspace lifecycle, existing fixtures, and deployment instructions.

Original implementation completed below. The subsequent Cal integration update is recorded at the end; its unified rollout contracts supersede the original converter names.

Implementation checkpoint:

- Snapshot writes cover native creation, decisive provider proof, legacy admission, and canonical chain merges. Pending/failure paths preserve the prior coherent snapshot.
- Viewer exposes admin-only setupCall; workspace renders it directly. Header-only query/retry removed, background revisit retained.
- Added bounded dry-run/apply snapshot/reference reconciliation with unresolved IDs/reasons, and documented rollout/temporary compatibility removal.
- Existing component fixtures now use setupCall. No test cases/assertions added or removed.
- First validation: test:perf passed 7 files / 36 tests; app/tools checks passed with 0 Svelte errors/warnings; Convex tsc passed. Further backend merge/order changes require rerunning final verification.

Validation checkpoint:

- Final production build passed, including app/tools checks (0 Svelte errors/warnings).
- Final test:perf passed (7 files / 36 tests), Convex TypeScript passed, loading dependency boundaries passed.
- Targeted component run: loading-boundaries passed (6 tests); csm-preload has 4 passing and 4 failing tests. Ran the original pre-task files in an isolated temporary copy: exactly the same four support-calendar failures occur (missing slots and expected refresh count). Assertions preserved; no unrelated calendar fixes made.
- Baseline reproduction: /var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/setup-call-component-baseline-wgryi2yv; output /tmp/confirmed-setup-call-baseline-tests.log. Build output /tmp/confirmed-setup-call-build.log.
- Removed unused reserved-delay plumbing after retiring header retry; pending provider checks retain the transitional marker when no coherent snapshot can be recovered. Rerun perf and Convex types after this final backend cleanup.

Manual transitions reviewed in source: accepted -> cancelled -> failed/uncertain replacement retains cancellation -> confirmed replacement atomically binds new snapshot and retires source; pending successor keeps prior dates; repair/freshness expiry never clears snapshot; call end hides only scheduled reminder; release returns no setupCall; viewer/session ownership scopes navigation and account changes. These display transitions and real provider behavior remain unverified in a browser/live environment. No deployment or data operations performed.

Complete:

- Final backend cleanup verified: test:perf passed again (7 files / 36 tests), Convex tsc passed, formatting passed, git diff --check passed.
- Existing saving/scheduling/cache and provider/account performance guarantees passed. Existing loading-boundary component assertions (6 tests) and production bundle boundaries passed. Four support-calendar component failures independently reproduced using the pre-task baseline; assertions were not weakened or removed.
- New display transitions were reviewed in source but have no direct automated coverage; user browser verification and live provider/deployment/reconciliation checks remain outstanding by design.
- Additive compatibility remains intentionally until the separate deployed-data/client transition; removal sequence is documented in docs/assisted-template-setup.md. No live operations, deployment, new tests, or browser checks performed.

Cal integration update (local source, 2026-11-13):

- Preserved the coherent viewer/header contract above. Failed refresh/pending hints
  leave confirmed facts intact; scheduled notice ends at call end, cancelled notice
  remains until confirmed rebooking/release, and no unknown-status header is added.
- New creation freezes explicit numeric event/organizer scope, opaque dispatch and
  exact reference. `CAL_METADATA_SIGNING_SECRET` is separate from delivery-only
  `CAL_WEBHOOK_SECRET`; preserve the old delivery key as
  `CAL_LEGACY_METADATA_SECRET` for historical verification before rotation. Missing
  configuration refuses new creation without clearing existing presentation.
- Initial/replacement share sanitized company recovery. Automatic GET-only due work,
  durable webhook inbox, semantic duplicate identity, finite ten-pass retry/review,
  exact sender/lease/generation/coverage fences and exhaustive operator chain review
  replace silent or recurring impossible recovery. Erased initial uncertainty keeps
  non-personal guards; only exact terminal-before-investigation proof can release,
  and positive discovery retains the guard without personal reconstruction.
- Template release retires appointment maintenance in bounded batches and late-work
  relevance fences, retaining history/snapshots/invitations. Creation outcome recovery
  remains independent. Cold display still uses concurrent configuration/slots GETs
  and the existing browser cache; no shared server cache, slot reservation or
  provider-wide exactly-once claim is introduced.
- One live mutation/ack/query contract replaces receipt negotiation, public context
  issuance and old settlement adapters. Canonical writers use coherent snapshots
  and bounded pending hints. Historical decoding/import/discovery are isolated in
  `csmHistory.ts` / `csmHistoricalAppointments.ts`; original identity may be frozen
  only through authenticated historical proof.
- Unified `csmMaintenance:normalize` dry-run/apply populations replace the old receipt,
  snapshot/reference and supersession converters. Page-local IDs/reasons,
  converted uncertainty and eligible/needed/added recovery enrollment stay visible.
  Apply reuses the live reducers, preserves lease/backoff/review/budget and never
  schedules sender. Missing scope/reference/original attendee remains guarded review.
- The four runbooks now agree: `docs/delegation.md`,
  `docs/assisted-template-setup.md`, `docs/deployment.md` and this record. Actual
  env/deployment/provider inventory/apply/operator/browser work was not performed.
  Schema contraction requires empty/disposed inventories, safely retained unresolved
  obligations, retired old clients/readers/writers, drained old scheduled names and
  accounted-for old issued URLs. A finite import does not retire a still-usable link.
- Local automated results for this update are recorded in the P4 implementation
  artifact. Existing perf guarantees/types/build/loading are checked separately from
  new source-reviewed inbox/enrollment/review/erasure/release transitions; no tests
  or cases were added. Earlier four component failures above describe the original
  historical run, not a claim about the current suite.
