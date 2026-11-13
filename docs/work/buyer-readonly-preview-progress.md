# Read-only buyer preview

## Scope and decisions

- Approved implementation of the refined plan on 2026-11-10.
- Keep the existing seller header. Reuse the actual buyer renderer below it with
  an explicit live read-only discussion policy; no duplicate page or fake buyer.
- Retain drafts, exact pending operations, cookie-lock ownership, public reading,
  downloads, and seller analytics exclusion. Fence delayed dispatch across toggles.
- Preserve all pre-existing working-tree changes. Baseline copies of touched files:
  `/tmp/oceans-readonly-preview-baseline`.
- No new tests or browser checks. Run the required performance suite and build.

## Evidence and progress

- `BuyerDocument.svelte` already renders the public buyer projection; preview only
  hid seller additions while `DiscussionSession` kept its seller actor and writes.
- `MessageByline.svelte` consequently calls the seller “You”. Composer, reply,
  edit/delete, private proposal facts, bootstrap, and transport need the same policy.
- Implemented a live policy on the retained discussion session. Preview removes
  seller-relative authorship, authoring/recovery/private facts, and retained-composer
  layout while preserving public reads, pagination, applied status, and navigation.
- Centralized preview transitions behind a generation counter. Viewer bootstrap,
  queued cookie-lock owners, auth refresh/retry and all discussion writes recheck
  captured permission before dispatch. Seller proposal apply checks the same mode
  generation after its asynchronous work gate.
- Drafts and exact operation records remain retained. Already-dispatched cookie
  owners settle under their original lock; late writes settle without restoring
  editors or taking preview focus.
- Updated the route specification and superseded the presentation-only preview
  decision in the previous workspace progress document.
- Scoped source/diff review complete. Header, backend/schema, public projection,
  download, analytics exclusion and copy-confirmation paths unchanged.

## Validation

- `npm run test:perf`: 39/39 passed in 7 files. Existing guarantees cover saving
  validation/replays/work budgets, queued scheduling/cancellation, snapshot cache
  reuse, and the suite's startup/creation/support checks. No assertions changed.
- `npm run build`: passed, including Svelte check (0 errors, 0 warnings), tool type
  checks and production bundles. Scoped whitespace check passed.
- Logs: `/tmp/oceans-readonly-preview-{perf,build}.log`.
- No new tests, browser work, backend sync or deployment. Existing automated suites
  do not directly prove preview identity, UI visibility or auth/toggle race behavior.
- Manual checks remain: actual-buyer comparison on desktop/mobile, draft restoration,
  navigation, auth/pending-write toggles, download, and deployed analytics exclusion.
