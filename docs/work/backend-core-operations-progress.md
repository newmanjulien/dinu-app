# Core operations and export ownership

> Historical implementation/review snapshot. Recorded results describe that stage only.
> Contract conversion, tuple-chunk and compatibility instructions below are superseded by
> the [current contract release procedure](../deployment.md#backend-ownership-conversion).
> Read the current architecture in [data model](../data-model.md); no live cutover is certified here.


Completed local implementation for the approved backend redesign. No deployment,
live backend calls, browser checks, or new test coverage.

- Generic operation helpers now live in `src/convex/operationReceipts.ts` and write
  `operationReceipts` / `operationReceiptChunks`. Legacy receipts remain readable
  until their bounded migration verifies or copies exact inputs/results and
  atomically removes the old row/chunks. Keys, terminal outcomes, replay checks,
  and the 63-chunk envelope are preserved. `retirementStatus` checks the old tables.
- `contractExports.ts`, `exportActions.ts`, `exportValidators.ts`,
  `exportRetention.ts`, and `exportProvenance.ts` own core download preparation,
  capture, claims, artifacts, release, acknowledgment, byte expiry, and provenance.
  Physical `hubspotExports` / `hubspotExportChunks` IDs and legacy API routes stay
  intact. `legacyExportAuthorization.ts` preserves pre-attempt action completion.
- `hubspotExportDeliveries.ts` owns the captured provider destination, remote
  upload identity, and attachment entitlement. Its reader falls back to old root
  fields; normalizer/backfill removes those fields after adopting the child.
  `retirementPage` reports legacy roots, invalid child ownership, and duplicates.
- Provider sending, settlement, uninstall phases, and storage ownership use the
  new boundary. Late acknowledgment uses the captured actor/destination without
  requiring a live contract. Company cleanup accepts the caller's shared budget;
  individual contract deletion does not delete these operation/export records.
- Existing integration fixtures/assertions now read the explicit Contract
  aggregate and provider delivery child. No assertions were weakened. Duplicate
  acknowledgment equality covers both the attempt and delivery state.

Evidence: `npm run test:hubspot` passed 60/60 tests across five files
(`/tmp/backend-core-hubspot-final.log`). Backend TypeScript passed after the
retirement helpers (`/tmp/backend-core-retirement-tsc.log`). Targeted whitespace
checks passed. Parent workstream owns final perf/lifecycle/build verification and
company-deletion integration.

Live rollout, actual legacy data migration/retirement, and provider uninstall
against a deployment remain unverified because live operations were excluded.
