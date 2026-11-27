# Remediation plan for the two round-trip plans

Updated: 2026-11-26. Status: planned; no application changes made for this plan.

This plan covers every open finding in the [two-plan review](two-plan-work-review.md): C1–C11, A1–A4, and P1–P7. The previously corrected R1/R3/R4/R5 issues need verification. It takes over the remaining verification and release work from the [local data plan](local-first-implementation-plan.md) and [follow-up round-trip plan](remaining-round-trip-plan.md); their historical records remain useful evidence.

The goal is fewer unnecessary Convex executions and faster usable interactions while preserving current permissions and shared state. Track client subscription starts, actual Convex executions, backend documents/bytes read, provider calls, local IndexedDB opens, and user-visible readiness separately. Measure request reduction independently of display cache hits.

## Working rules

- Update this file **and** the [review](two-plan-work-review.md) as work proceeds. For each finding, record the chosen change, source files, observed effect, checks, and what is still unverified. Add any newly confirmed issue to the review and the coverage map here before closing a phase.
- Keep server authority for permissions, membership, link claims, writes, and current search results. Provisional data must be scoped and visibly replaceable by current results. Failed or unavailable storage must not block the foreground path.
- Prefer one owner and one retry policy for the same retained data. Remove an optional cache or subscription when it cannot show a useful benefit after accounting for its background work and invalidation cost.
- Tests have their own Phase 5. Do not add test cases or expand the suite without a user request. Maintain existing fixtures and assertions where behavior changes. The repository also requires `npm run test:perf` when saving, scheduling, or caching changes; run that required check when such changes are made and record it in Phase 5. Do not use browser automation. Native/browser acceptance is user-led unless an agent browser check becomes absolutely necessary.
- Do not call a phase complete because its code compiles. Distinguish **implemented**, **checked locally**, **measured**, **released**, and **blocked** in the progress record. Do not claim a speedup from source-level call counts.

## Progress

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Establish evidence and release feasibility | Planned |
| 2 | Repair retained-data and cache lifecycle | Planned |
| 3 | Repair interaction currentness and repeated work | Planned |
| 4 | Reduce avoidable backend reads | Planned |
| 5 | Verification and measurement | Planned |
| 6 | Integrate, document, and release | Planned |

## Phase 1 — Establish evidence and release feasibility

1. Inventory the entire dirty worktree against `HEAD` and the two plans. Identify which changes belong in one reviewable release unit, which are unrelated, and the exact source revision used for comparisons. Do not silently include the current 100-plus-file worktree in a release.
2. Recheck each intended Convex target before implementation depends on its state. Record the publisher projection/index population and the independent preservation facts: the seven `csmWebhookEvidence` records, both sweep cursors including `retentionSweeps`, component and file state, pending/running old jobs, old clients, and external outcomes. Mark each G01–G25 gate with evidence or a precise blocker. Do not treat empty `buyerLinks` as clearance for the other tables.
3. Rebuild the missing preservation runbook, converter, manifest, and inventory in a durable, reviewable location, bound to the actual original and current exported schemas and source dependencies. Record any facts that cannot yet be preserved or converted. The final source binding and rehearsal happen in Phase 5 after code changes.
4. Capture a compact baseline for Team return, saved document reopening, Home buyer links/presence, template reopening, Support preference changes, reply paging, and setup booking. Use existing logs and instrumentation where available; do not generate production traffic just to fill a table. Record requested operations separately from observed server executions and usable time. Where no comparable trace exists, say so.
5. Finish the bounded source leads in the review's “Still checking” section: cache-registry/draft and Home invalidation failures, discussion pause/resume, and remaining changed UI paths. If a new issue is confirmed, assign it an ID and place it in the relevant phase. Provenance remains separate from whether the behavior needs repair.

**Exit:** A reviewable change inventory, an available source-bound preservation kit, a target gate table with explicit holds, and a baseline with missing measurements labeled. A blocked production gate does not prevent local implementation; it prevents release.

## Phase 2 — Repair retained-data and cache lifecycle

1. Give workspace reads and contract snapshots the same bounded optional-open contract: a deadline for each caller, reusable owner state, a bounded retry after transient lease/open failure, adoption of a safe late success, and reliable lease/DB disposal on scope exit. This fixes the terminal snapshot miss (C5) and settled failed workspace lease (C6). Preserve deletion holds, account isolation, and foreground fallback.
2. Let template source/view hydration retry after an unavailable or timed-out disk read until a current live result supersedes it (C7). Renew the buyer-link seed's durable freshness after unchanged confirmed live results without writing the full payload on every delivery (C8). Correct template-detail eviction so only accepted entries consume the byte and eight-entry budgets (A4).
3. Trace which confirmed contract changes can actually stale Home buyer-link rows. Keep required invalidation, but avoid opening IndexedDB on every direct-route save solely for that deletion (C4). Use a durable cheap invalidation fence with deferred physical cleanup if it remains safe across reloads and tabs; otherwise remove the disk seed if its benefit does not justify the write path. Never suppress invalidation only because Home is unmounted.
4. Record a scoped failure/backoff for visible-card snapshot warming. An unrelated scroll, key, or click must not automatically repeat a failed Convex read for the same unchanged card; an explicit foreground open/retry and a relevant state/version change can bypass the backoff (C11).

**Exit:** C4–C8, C11, and A4 have concrete outcomes; optional storage recovers after transient failures, and repeated Home interactions do not reissue a persistently failing background read. Cache retention and invalidation rules are written down with their remaining native uncertainty.

## Phase 3 — Repair interaction currentness and repeated work

1. Replace Team's one-time route snapshot with a scoped owner that can retain the **actual pager state/subscriptions** for a bounded short return, expire reactively, and respond to successful Team writes, membership/permission changes, and workspace exit (C1/C3). Compare return-time executions with off-route reevaluation cost. If retaining live pagers does not save useful work, remove `TeamDisplay` and record why Team returns should use current live pagers alone; do not keep a display-only cache under a request-reduction claim.
2. Make the Support preference writer compare the latest desired value with the last successful in-flight value before sending another mutation. Preserve explicit failure/retry and cross-device updates (C2).
3. Tie HubSpot picker options and selection eligibility to the normalized current input term. While a new term is debouncing or pending, old-term rows may be displayed only if they cannot be selected as current results (A1).
4. Make each reply page, including split children, own a retryable pending/error state. On split failure, clear the loading flag, preserve loaded rows and a retry cursor, and expose an action. Retry only the failed older page instead of restarting every page and the first-page subscription (A2/A3). Keep viewport pause/resume and native pagination cursor behavior intact.

**Exit:** C1–C3 and A1–A3 have resolved currentness/retry behavior. The Team decision explicitly reports whether client subscriptions and observed Convex executions were reduced or merely moved off-route.

## Phase 4 — Reduce avoidable backend reads

1. In `buyerLinks.dashboardPresence`, avoid setup/creator reads when company link absence makes them irrelevant to the only Home caller (C9). Compare the linked-company critical path before deciding whether its remaining independent reads should run concurrently. Keep the publisher index and the same UI semantics.
2. In `csmBookings.setupOpening`, reuse the already authorized pending attempt row and start an independent exact-ID lookup without waiting for unrelated progress work (C10). Keep the single authorized opening result, ownership checks, operation binding, and exact-attempt rebind.

**Exit:** C9/C10 have fewer proven redundant database reads without an unexamined serial delay on the visible path. Record backend reads and elapsed time separately from the count of client subscriptions.

## Phase 5 — Verification and measurement

1. Run the required `npm run test:perf` for caching changes, the existing affected suites when necessary, Convex/app type checks, and the production build. Maintain affected fixtures without weakening assertions; add no new test cases. Record exactly what each check guarantees. Recheck the corrected R1/R3/R4/R5 paths through existing coverage and source review.
2. Check the source and available native evidence for transient Web Locks/IndexedDB recovery, multi-tab and identity changes, Team expiry and write invalidation, HubSpot term transitions, Support rapid changes, reply split/older-page retry, foreground snapshot retry, Home seed durability, and setup authorization. Request user-led browser acceptance only for behavior the available checks cannot establish. Mark native or live behavior unverified when it was not observed.
3. Compare the Phase 1 baseline revision with the final revision under equivalent environments and cache states where possible. Report client calls, actual Convex executions, documents/bytes read, provider calls, IndexedDB work, and usable time separately. Keep first-open, short-return, and failed-path samples separate. If comparable before/after traces remain unavailable, close only the source-level claim.
4. Rebind the preservation kit to the final source and exported schema, verify every artifact exists, and rehearse the non-destructive conversion/recovery path against the exact classified target state. A failed or unverified gate remains a release hold.

**Exit:** One evidence matrix states what passed, what was observed in a native/browser setting, what was measured, and what remains unverified. No “verified locally” label is applied to behavior outside those checks (P4/P6).

## Phase 6 — Integrate, document, and release

1. Update the [architecture](local-first-architecture.md), [data model](data-model.md), performance notes, old plan statuses, this plan, and the review to match the implemented Team and provisional Home search behavior (P1/P7). Separate source decisions, local verification, measured outcomes, and release state everywhere.
2. Produce a reviewed release commit or set of coherent commits from the Phase 1 inventory. Check the final diff, generated/schema dependencies, durable kit paths and hashes, and unrelated work before any push (P3/P5).
3. Re-inventory the exact target and clear G01–G25, old jobs/clients, external obligations, recovery snapshot, data-preserving conversion, and publisher-index prerequisites. Follow the documented release order only when these are cleared; an unresolved fact keeps the release held (P2). Do not use a destructive reset as an implicit fallback.
4. If released, observe representative production flows and record actual backend work and usable-time changes against a comparable baseline. Update the review and plans with results, regressions, and any continuing hold. Treat local implementation as distinct from a deployed performance outcome (P1/P6).

**Exit:** The release unit and documentation are reviewable; production is either released with a truthful comparison or explicitly held at a named gate. The overall performance objective is not marked achieved on local checks alone.

## Finding coverage

| Finding | Resolution phase | Finding | Resolution phase |
| --- | --- | --- | --- |
| C1 Team snapshot lifetime | 3 | C2 Support duplicate mutation | 3 |
| C3 Team request reduction | 3, 5 | C4 save-time disk invalidation | 2 |
| C5 snapshot open lifetime | 2 | C6 workspace lease retry | 2 |
| C7 template hydration retry | 2 | C8 buyer seed freshness | 2 |
| C9 presence backend reads | 4 | C10 setup attempt reads | 4 |
| C11 failed card warm retry | 2 | A1 HubSpot picker currentness | 3 |
| A2 split page failure | 3 | A3 older-page retry | 3 |
| A4 template eviction | 2 | P1 completion claims | 5, 6 |
| P2 late release feasibility | 1, 6 | P3 missing temporary kit | 1, 5, 6 |
| P4 thin verification | 5 | P5 dirty release unit | 1, 6 |
| P6 missing comparisons | 1, 5, 6 | P7 reference doc drift | 6 |
| R1/R3/R4/R5 previously fixed | 5 | Open audit leads | 1, then assigned by finding |

Nothing in this coverage map establishes that a proposed change is already implemented or measured.
