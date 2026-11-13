# Buyer discussions implementation

Scope: approved shared commenting UI, persistent buyer/workspace discussions and custom wording proposals; one permanent link and transactional released publication; first-approval warning once per admin/contract; reset explanation and published-link status.

Decisions: no buyer identity form, buyer placeholder avatars; account avatars for workspace members; anonymous ownership uses HttpOnly browser cookie; no notifications. Pending/rejected/reset reviews retain previously released wording. Related edits publish together. Proposals reuse immutable contract-owned concessions and existing save/approval mechanisms, preserving secondary effects. Fresh database rollout, no compatibility migration or database wipe by agent.

Constraints: preserve existing unrelated work and copy feedback host/callback; no new tests or browser checks. Required existing perf suite for saving/caching changes, production build and relevant existing security/export checks. No production deployment without explicit authorization.

Progress: inspected current files and existing approval/save/link/auth/export paths. Implementation starting with identity, publication, and permanent links.

Next: persistent discussion service and trusted ingress, proposal application, reference UI integration, warnings, cleanup, type/build/perf checks, final review.

Implemented: permanent link model and removal of version UI; transactional released projection and group conflict calculation; revision-checked download; persisted admin acknowledgment and modal/reset/status copy; immutable local concessions and contract reader; discussion schemas/service/secret ingress with cookie/account ownership, rate limiting and receipts; proposal normalization preserving inherited effects/references; shared reference-style cards/composers, selection actions, rail; bounded cleanup and live feeds.

Validation in progress: first type pass exposed identity typing at template authoring boundaries; narrowed template-specific records while sharing the contract identity through rendering/exports. Existing loading-recovery test is maintained against the new discussion feed because link history was removed. No new tests added. No browser checks. Codegen only has run (CLI documents that it does not change running deployment functions); configured target is dev:disciplined-squid-496, no deploy/wipe yet.

Verification checkpoint: existing perf 36/36, export/security 19/19, loading-recovery 5/5 passed. Production build passed with zero Svelte/type errors. Subsequent final edge fixes are being rechecked: reference text highlighting and native click activation; preserving drafts on publication-read failure; showing newly created threads beyond first page; safely applying edited proposal revisions to their exact prior immutable application; integer anchor validation and bounded custom-definition reads. Existing analytics/auth improvements changed concurrently in the workspace and are retained, including dedicated discussion quotas and expected-author retry binding. No data wipe or deployment performed.

## Completed implementation and verification

- Persistent shared discussions use authenticated account authors or a private browser credential; public author keys are presentation only. Own-message edits/deletion and expected revisions are enforced in shared server logic. Replies survive root deletion; operation receipts survive message deletion.
- Proposals create immutable contract-owned definitions and use the existing save/approval pipeline. Reapplying an edited proposal revision targets the exact prior application and preserves its other effects and references.
- Permanent-link publication retains released text across pending/rejected/reset reviews. Conflict-connected groups release together; independent edits release immediately. Buyer downloads pin and recheck the displayed public revision.
- Admin publication warning acknowledgment is persisted per profile/contract and enforced server-side for approvals and autoapproved saves. Reset explanation and publication status copy are wired; existing clipboard confirmation ownership is preserved.
- Reference selection actions, text highlights, anchored cards, reply/edit composers, account avatars and buyer placeholder are connected to live feeds. Mobile navigation includes access to changed passages and additional pages. Read/auth failures preserve open drafts; new comments appear without scanning old pages.
- Contract/company cleanup includes definitions, discussion state, durable receipts, acknowledgment and dedicated rate-limiter ownership.

Passed: `npm run test:perf` (36); existing integration export/security checks (19); existing loading-recovery checks (5); `npx convex codegen --typecheck enable`; production build including Svelte/type/tool checks; `npm run verify:loading-bundles`; targeted whitespace checks. Logs: `/tmp/buyer-perf.log`, `/tmp/buyer-integrations.log`, `/tmp/buyer-recovery.log`, `/tmp/buyer-codegen.log`, `/tmp/buyer-build.log`, `/tmp/buyer-bundles.log`.

Existing performance assertions remain intact, with publication writes counted separately. Existing recovery coverage was adapted from removed link history to the live discussion feed. No new tests, browser checks, database wipe, or deployment were performed. New multi-user discussion/approval scenarios and visual interactions have not been exercised end to end; browser verification remains with the user. The agreed fresh-database rollout is a release prerequisite.

Final checkpoint: production build completed successfully after the draft-retention fix; zero Svelte/type errors. Latest performance run passes 37 checks (the workspace gained concurrent coverage), export/security 19 and loading-recovery 5. Loading dependency boundaries also pass. Running deployment and database remain unchanged.

## Matching comment-card alignment

Desktop comments now share the admin cards' exact first-character measurement and workspace-top clamp. The highlight controller retains a page-local anchor on each range record, keyed to clean page geometry, and reprojects it when scrolling or scaling. Cold starting pages retain the approximate page-top fallback; selected comments request geometry through the existing path. Highlight bands and generated-text anchor validation stay unchanged.

The selected comment or composer stays at its anchor. Other cards pack in deterministic order around its reserved space, moving downward when they cannot fit above it; they cannot shift selection away from its text. Admin preview holding and mobile sheets stay unchanged.

Validation: `npm run check` passed with zero Svelte errors/warnings and passing tool types; `npm run test:perf` passed all 37 existing checks. Targeted formatting and whitespace checks passed. Source review covered cache replacement/removal, dirty and cold starting pages, scale projection, selected-at-zero and crowded packing, gap boundaries, and empty/missing-selection paths. No tests were added or changed. Browser text metrics, pixel parity, and visual interactions remain unverified; no browser checks were performed.

Audit follow-up: consolidated selected and ordinary packing into one forward traversal with an optional selected-card reservation. Highlight groups now live with their active controller/rail pair. Reconciliation retains unchanged range records across selection updates, clears removed/unresolved groups and replaced owners, and refreshes paint for both old and new selected cards. Final teardown clears the captured controller's groups; selected-only geometry requests and coalesced rail scheduling remain intact.

Follow-up validation: `npm run check` passed with zero Svelte errors/warnings and passing tool types; `npm run test:perf` passed 37/37 existing tests across seven files. These tests check existing saving, snapshot caching, scheduling, creation, startup and support-booking guarantees; they do not directly exercise the discussion rail, anchor cache or selection lifecycle. Targeted `npx prettier --check` and `git diff --check` passed. Static review traced selected/missing/empty packing, exact gap boundaries, retained rectangle/null records, old/new selection paint, real group removal, owner/kind/range replacement and controller/rail/inactive/unmount cleanup. No tests were added or changed and no browser checks were performed. Runtime cache-hit counts, performance impact and browser alignment/interactions remain unverified. Evidence and command logs: `/tmp/oceans-alignment-remediation/`.
