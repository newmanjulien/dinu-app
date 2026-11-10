# Audit remediation follow-up (complete)

User approved /tmp/dinu-link-activity-audit-20261109-152017/final-plan.md. All five remediation groups implemented, covering seven findings and linked underlying cause.
R-01: projectVisits owns shared contract/deletion gate; prepared permits existing history projection, every dispatched/later state or missing parent stops it. Recorder/backfill/continuation all use that gate; public intake/access remain fenced during preparation.
R-02: same indexed permanent-number allocator now feeds live insert directly; historical wrapper measures key/number changes only. Immediate event rereads/identity patch removed. identified remains schema-only legacy admission, no active writer/consumer.
R-03: one latest-summary read per nonempty drain, transaction-local successor state, final-state first-event insertion, no fresh-ID membership query. Continuing clause membership/raw projection patches retained; 20-event cap, chronological guard and >=30min split unchanged. Capacity reserves retained with explicit one-time latest-read check; live reserve covers allocation and gate reads.
R-04: LinkActivity reuses unchanged useReadQuery; loading masks retained data, errors first, hook owns timeout/retry/fencing/cleanup; panel retains open clock and list measurement. Static classes and rendered markup identical except retry binding; backend recent query unchanged. Shared copy feedback intact.
R-05: guide/data-model corrected for ten latest active visits, compatibility-only flag, preparation/terminal policy, separate repeat-sweep recovery and prior-writer numbering prerequisite.
Validation: backend tsc exit0; existing test:perf 36/36 in seven files; full npm run build exit0 with zero Svelte errors/warnings and tooling types; targeted Prettier and whitespace checks passed. Personal dev push to disciplined-squid-496 succeeded 15:53:01 (8.85s), schema/functions/codegen accepted. Read-only before/after dev checks each scanned all 32 raw rows: 24 numbered, zero pending, eight legacy unidentifiable; after check found one summary. No recovery sweep needed or run. No synthetic events/deletion markers, new/expanded tests, browser or production actions.
Source acceptance reviewed for lifecycle states, exact boundary, four event transitions, repeated-clause membership, batching, identity order and subscription states. Runtime boundaries/multi-clause/concurrency/>20-event/lifecycle interleavings, fresh live writer and browser visuals/focus/scroll remain unexercised. Current dev data did not require any historical changes. Production recovery/rollout remain separate scoped operations.
Evidence/baseline/diff/source review: /tmp/dinu-activity-remediation-20261109-155042/.
Logs: /tmp/dinu-activity-remediation-{types,perf,build,convex}.log. No required source work remains.

# Contract-card link activity

Current follow-up (approved, complete): server-defined visits split after >=30min
without recorded link opens/clause clicks, across reloads/tabs/link versions. Flat
rows: first visit opened the link; subsequent visits returned; one clause row per
visit counts distinct clauses and updates its last-click time. Opening timestamp
stays at visit start; all rows newest first. Five visible rows measured to handle
wrapping, older bounded history scrolls; scroll list is keyboard-focusable. Keep all
prior styling/390px width/icon/tag/city fallback/copy feedback.
Implemented buyerVisits summaries + chronological pending-event drain shared by
recording/backfill; optional activityVisitId/projected/clauseId on raw history;
indexed distinct-clause membership; bounded 20-event continuation. Client visitId
remains page-delivery identity only. Existing company/contract activity cleanup
phases also drain summaries, preserving support for in-flight cleanup markers.
Continuations/backfill check parent contract and company deletion marker. Docs updated.
Production prerequisite: complete previous groupVisitors numbering before deploying
visit projection if identifiable legacy history is still unnumbered.
Validation: backend tsc, targeted formatting, full final npm run build (0 Svelte
errors/warnings, tooling types and production bundle) passed. Existing test:perf
passed all 36 (cleanup continuation integration changed). Personal dev push succeeded
15:15:37 on disciplined-squid-496, including schema/index validation. Live activity
arrived during rollout and recording drained historical events via the shared path;
subsequent groupVisits sweeps each processed 25 raw rows, projected 0 (idempotent).
Data inspection preserved all 20 original events/fields apart from three new projection
fields. Five new real openings arrived; all 17 identifiable events share one continuous
visit (every adjacent gap <30min), eight unidentified rows remain history-only. Visit
start/last/clause timestamps, number, membership and distinct clause count match raw
history. Actual seller-authorized recent query with CLI dev identity returned two
rows (clause/open), count 1, You tags. No production actions, seeded activity, new
tests or browser checks. Multi-visit boundary/return wording, multiple/repeated clause
counts, tab-concurrency stress, >20-event continuation and visual/keyboard scrolling
were source-reviewed but not exercised by the existing live data. User checks visuals.
Evidence: /tmp/dinu-visits-{before,after,summaries,migration,evidence,feed}.json;
logs: /tmp/dinu-visits-{codegen,types,build,final-build,perf,convex}.log;
baseline source copies: /tmp/dinu-visits-before/.

Current follow-up (approved): flat list, newest first, one row per action; stable
Visitor N labels within each contract distinguish visitors even in the same city.
Keep relative times, You/Colleague tags, existing styling, width 390px and temporary
dev city fallback. Implemented source: identifyVisitor assigns/reuses transactional
contract-local numbers in history; three bounded identity/number/feed indexes replace
the obsolete latest-visitor indexes and marker writes. recent returns ten identified
events. Existing groupVisitors sweep numbers identifiable historical events without
changing event payloads, times, or IDs; legacy unidentified rows remain history-only.
Old latestForVisitor is schema-only compatibility, removable by existing cleanup.
Validation complete: targeted formatting, backend tsc, full npm run build (0 Svelte
errors/warnings, tooling types and production bundle) passed. Push to personal dev
disciplined-squid-496 succeeded (15:00:41), validating new indexes/schema. Bounded
numbering sweep processed all 18 existing history rows: 10 identifiable events got
one stable visitor number; 8 unidentified rows remain history-only. Repeat sweep
updated 0. Before/after comparison preserved every original event and field apart
from new identity/display metadata. Read-only indexed feed check returned 10 rows,
newest first, including separate link and clause actions for the same visitor.
Number-to-identity mapping is consistent and unique in existing data (one visitor);
multiple-visitor/concurrent allocation was source-reviewed, not seeded or driven.
No new tests or browser checks. No changes to saving/scheduling/caching; test:perf
not rerun. No production actions. User handles visual/browser review.
Evidence: /tmp/dinu-numbered-activity-{before,after,feed,migration,evidence}.json;
logs: /tmp/dinu-numbered-activity-{types,build,convex}.log.

Current follow-up (approved): unified link_opened/clause_opened events, explicit buyer
clause-summary activation callback (seller previews inert), ordered background delivery
with stable event/visit IDs and per-visit sequence, server snapshot clause validation,
one latest activity per visitor. UI: Recent activity / See recent activity; Someone
[in city] opened the link / clicked on a clause. Keep all approved sizing, padding,
border, shadow, light text, tags and temporary dev city fallback. Preserve history in
existing buyerLinkOpens store with optional event/visit/sequence fields (legacy rows
read as link opens), existing indexes and deletion paths. No new tests or browser use.
Implemented: generalized BuyerActivity client/context and one ordered queue (50-event
bound, four attempts with stable IDs), shared bounded activity parser with old-client
compatibility, /api/buyer/activity -> /buyer/activity with old /open aliases. Existing
history stores optional event/visit/sequence; snapshotReader.item validates clause
identity and summary in the linked immutable version. Same-visit sequence precedes
receipt time when atomically moving the latest marker. BuyerDocumentHost alone wires
the optional activation callback; already-selected clause and inactive view ignored.
UI now uses requested sentences and Recent activity labels. Follow-up: width 420px,
still bounded by FloatingSurface's available viewport width.
Validation: backend tsc, npm run build (0 Svelte errors/warnings), test:perf
(36 pass), targeted formatting passed. Convex push succeeded on personal dev
disciplined-squid-496 (schema accepted, 14:51:46). Final vite bundle after the width
change passed. verify:loading-bundles passed. Source reviewed snapshot clause
validation, event/version deduplication, delayed same-visit sequence, preview isolation,
active/visible gating, queue bound and existing contract/company cleanup coverage.
No new tests/browser checks, seeded activity, history migration or production actions.
Live browser activation, delivery/retry behavior and geolocation remain unverified.
Logs: /tmp/dinu-clause-activity-{build,perf,convex,final-bundle,loading}.log;
backend types: /tmp/dinu-activity-backend-types.log.

Approved: remove Links header/route/UI and unused analytics. Add adjacent Copy link + two-carets button, click-toggle panel styled like recording using existing app floating surface; latest 10 individual openings across all versions, relative time, verified same-company You/Your colleague tags. Keep historical visits, Past links and shared copy confirmation. No new tests/browser automation.

Completed: LinkActivity.svelte, ContractCard integration; Links page/group/skeleton deleted; header/catalog/skeleton/support cleaned. buyerActivity now only records openings and exposes seller-authorized bounded recent query. Server derives optional device and Vercel city headers; authenticated ingestion forwards them. Stable profile identity stored only for internal accounts. Obsolete counters/browser-number writes and directory eligibility writers/indexes removed.

Compatibility: legacy optional opening/directory fields and two retired analytics tables/deletion drains remain accepted, following existing buyerLinkMigration pattern. Added bounded removeActivityAnalytics (20 rows/200 KB per call), documented in docs/link-activity-removal.md. Data cleanup not executed; production untouched. Supported deployments must be cleaned before dropping compatibility schema.

Evidence: task-start copies /tmp/dinu-links-before; recording frames /tmp/dinu-link-reference-*.png. Copy controller -> feedback.show -> single CopyConfirmation host intact, including saved-status bubble, 8px raise and 2500ms dismissal.

Validation passed: npm run build (svelte-check 0 errors/0 warnings, tooling types, production bundle); npx tsc --project src/convex/tsconfig.json --noEmit; npm run test:perf (7 files,36 tests); npm run verify:loading-bundles (public frame, Contracts and buyer dependency boundaries). Convex dev --once succeeded on personal dev disciplined-squid-496, including schema/index validation. Source-reviewed auth, latest 10 descending, missing metadata/tag fallback, subscription lifetime, floating dismissal/focus. No new tests, browser checks, production deployment or live opening/location/account-tag behavior verification.

Follow-up approved: replace individual-opening panel with Recent visitors, one entry
per internal account or anonymous browser across all versions, most recent first.
Preserve every opening. Mark the latest identified opening in-place using optional
visitorKey/latestForVisitor fields and two bounded indexes, avoiding a parallel
summary table or scans of repeated openings. Missing historical identities stay
history-only. groupVisitors backfill is bounded/repeatable and cannot supersede newer
events. Source changes implemented and deployed to personal dev disciplined-squid-496.

Follow-up validation passed: npm run build (0 Svelte errors/warnings, tooling types,
production bundle); backend tsc; existing test:perf suite (36 tests). Convex dev push
validated both new indexes and schema. groupVisitors swept all 10 dev openings,
updated 2 identifiable events, retained 8 unidentifiable events, and produced 1
latest visitor entry. Repeat sweep updated 0 rows. Read-only before/after comparison
verified all 10 original opening documents and fields unchanged apart from the new
visitor markers, unique visitor keys and correct latest selection. No browser checks
or new tests; future cookie/account ingestion remains source-reviewed rather than
exercised end-to-end. Build/perf/push logs: /tmp/dinu-visitors-{build,perf,convex}.log.

Next: user handles browser/visual review. Production release, visitor backfill there,
and retired-data cleanup remain separately scoped deployment actions.

UI follow-up: renamed Your colleague to Colleague in the query/display contract and
docs; panel now uses shadow-card, matching ContractCard instead of shadow-floating.
City path remains unchanged: only x-vercel-ip-city from the buyer opening request
is captured; localhost provides no Vercel geolocation. Dev backend push passed on
disciplined-squid-496; Svelte diagnostics passed with 0 errors/0 warnings.
