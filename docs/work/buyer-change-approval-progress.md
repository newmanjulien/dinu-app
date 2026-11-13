# Buyer change approval implementation

## Scope and decisions
- Implemented the approved plan: private on-document acceptance and admin review; buyer-change management removed from right widgets.
- Template working/released selections stay canonical. Approved buyer effects compose independently into both documents; pending/declined effects do not enter dashboard applications.
- Reps stage Pending; admins accept immediately. Undo is on the passage. Admin decisions are in private left tags.
- Individual rollback blocks approved dependents. Reset removes the full approved chain, including hidden predecessors.
- Buyer submissions, completion, request coverage and delivery eligibility are separate from dashboard reviews.
- No legacy proposal migration or compatibility conversion; no database wipe performed.
- Existing unrelated work preserved. No new tests or browser automation.

## Architecture and evidence
- `src/convex/discussionProposals.ts`: exact root/revision acceptance, bounded normalization, fresh acceptance IDs and operation receipts.
- `buyerChangeState.ts`, `buyerChangeApprovals.ts`: independent decisions, source fingerprints, stale-parent guards, review generations and request retirement.
- `src/lib/contract/buyer-effects.ts`: shared composition; suppression retains original effect indices and provenance without changing canonical owners.
- `contractReader.ts`, `contractPublication.ts`, `documentExport.ts`, `contractExports.ts`, `hubspotQuotes.ts`: effective projections and immutable export ordering.
- `contractApprovals.ts`, `emailDeliveries.ts`, `emailNotifications.ts`: scoped requests/results, existing retry/dispatch safety, buyer return links.
- `src/lib/buyer/reviews.svelte.ts`, `BuyerChangeActions.svelte`, `BuyerDocument.svelte`: private authenticated lifecycle, hover/focus/tap acceptance, left tags, bottom submission and completion.
- `DiscussionThread.svelte`, `DiscussionSession`, `RepPlaybookPanel.svelte`: removed acceptance callbacks, facts, status summaries and buyer controls.
- Revised roots anchor to current approved output. Full deletions retain insertion boundaries; deletion of previously inserted paragraphs is supported separately from strict template-authoring rules.
- Autosave can retain unrelated local intent across buyer-only revisions, while immutable request identities and effect dependency checks remain enforced.
- Public projections and View as buyer omit private controls and review facts. Bounded contract/company cleanup includes acceptance and scoped review records.

## Validation
- `npm run test:perf`: 39 existing checks pass, including saving, scheduling, caching and startup guarantees. Fixed unnecessary source reads found on the first run; no assertions weakened.
- Existing lifecycle checks: 23 contract/save/readiness checks and 5 loading/recovery checks pass. Updated existing fixture payload shapes only; no tests added.
- `npm run build`: type checks (zero errors/warnings) and production build pass, including the deletion-boundary update.
- Convex code generation and backend TypeScript checks pass.
- Backend, including the final deletion-boundary update, deployed successfully to dev `disciplined-squid-496` without wiping data. The frontend uses this dev backend.

## Manual verification remaining
Browser interaction/geometry, role switching and buyer preview, the complete multi-user approval/rollback/reset flow, real email delivery and login return, exports and HubSpot delivery need manual checking. No browser or real provider actions were run.
