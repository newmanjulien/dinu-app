# Phase 8 development rollout results

Target: development `shiny-buzzard-89`, 2026-10-05. Browser checks used local Vite
and Chrome with the existing 113-block document, rendered across 18 mounted pages.
No tests were added or expanded; no Playwright or test suite was run.

## Deployment and cleanup

1. Deployed the staged company-name search index with prefix reads/writes retained.
2. Confirmed `search_companyName` was `staged: true`, backfill state `backfilled`.
3. Enabled the index and switched search reads, stopping all prefix writes.
4. Verified search, pagination, save timestamps, rename, and deletion using temporary
   contracts. Removed every temporary contract. The prefix table still contained
   only the four original Acme prefix rows.
5. Cleanup returned `{ deleted: 4, isDone: true }`, then
   `{ deleted: 0, isDone: true }` on a second invocation.
6. Separately deployed removal of the obsolete prefix schema, indexes, and cleanup function.
   Deleted the confirmed-empty physical table with Convex's dashboard API (HTTP 200).
   The company search index remained enabled with backfill state `done`.

Each backend deployment passed Convex type checking. No source references to the
obsolete table or cleanup function remain.

## Focused verification

| Area | Observed result |
| --- | --- |
| Admin ownership | 20 visits: one blocks subscription and one playbook subscription while mounted; both released on departure. A simulated departed playbook update triggered zero departed callbacks. |
| Selected toolbar idle | Two seconds produced zero page/node measurements, geometry notifications, highlight publications, selection updates, floating updates, or hover checks. |
| Geometry invalidation | Height-only viewport resizing and direct page-stack scaling each rebuilt zero glyph maps. |
| Document search | Six rapid inputs ending in `agreement` produced one DOM refresh. All 82 text matches were counted; 10 nearby ranges were materialized, inspecting 10 intersecting text nodes. |
| Distant search navigation | Previous from result 1 wrapped to result 82 on page 18; its active overlay appeared in the viewport. Clearing removed all search overlays. |
| Route loading | Hover requested the new-contract route data before clicking. Navigation reused that request and rendered all 18 pages. An unauthenticated route request returned a 303 gate redirect. |
| Company search | Two temporary matching contracts paginated in pages of one without duplicates and reached exhaustion. Built-in multiword and punctuation matching, rename, and deletion worked. |
| Save behavior | Unchanged and repeated selections left `savedAt` intact. A changed save updated it and moved the contract first in blank browsing. |

These browser checks recorded no uncaught runtime errors. Counters were cumulative;
the table reports deltas for the individual operations rather than total session work.

## Limits and remaining rollout work

No reliable pre-change timing trace was available, so these results establish the
current work bounds; they do not quantify an end-to-end speedup against the original
baseline. The final pass did not repeat font changes, table edits, cross-page
selection, retries, or edits made during an in-flight save. Backend save checks
confirmed timestamps and outcomes; they did not capture transaction read/write metrics.

The backend rollout is complete on development. Public frontend and production
rollouts remain pending explicit target authorization. No UI or UX changes were
made during this rollout.
