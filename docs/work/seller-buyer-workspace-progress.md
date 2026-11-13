# Seller and buyer workspace split

## Scope and decisions

- Implementation approved after the plan-refine pass. Preserve pre-existing work.
- Dashboard: private rep instructions, internal concessions and admin approvals.
- Permanent buyer link: buyer guidance, shared discussions and proposal handling.
- Existing dashboard sessions enable seller view; no buyer-page login flow.
- Seller header: View as buyer, avatar linking back to dashboard; seller-only heading
  “Work through the contract with {buyer company}” and the existing support widget.
- Preview keeps the seller header and reuses the buyer view below it in read-only
  mode. Retain private drafts and pending operation identity; show stored author
  names, hide authoring/private facts/support, fence writes across mode transitions,
  and exclude seller visits from analytics.
- Proposal conversion reuses native concessions, approval/publication policy,
  idempotency and work gates. Compare affected working/released effects before writes.
- No new tests or browser automation. Required performance suite, relevant existing
  lifecycle checks, type checks and production build; report remaining manual checks.

## Evidence

- Buyer routes bypass full account startup: routes/+layout.svelte, hooks.server.ts.
- BuyerShell/BuyerDocument own public released state and token DiscussionSession.
- RepWorkspace currently owns the same shared discussions; remove that wiring.
- buyerLinks, discussionProposals, contractSaving and contractPublication own
  permanent links, proposal conversion, approvals and released selections.
- CsmWidget/preload/booking currently depend on dashboard viewer context and admin
  access; narrow their dependencies for seller support while retaining setup limits.
- Baseline copies of touched existing files: /tmp/oceans-seller-view-baseline.

## Progress

- Implemented seller recognition on a separate authenticated transport; public
  document lifetime remains independent. Auth changes and access loss clear controls.
- Removed shared DiscussionSession/UI from RepWorkspace; retained native concessions.
- Added seller header/avatar, company heading, preview/return focus handling and
  lazy shared support. Read-only preview supersedes the original presentation-only
  behavior; implementation and validation are tracked in
  `buyer-readonly-preview-progress.md`.
- Added proposal displayed/message/internal revision fences and checks covering
  displaced/inherited effects, preserving native saving and publication policy.
- Excluded verified sellers at trusted analytics intake and client delivery, with an
  explicit terminal excluded response and cancellation of queued work.
- Refactored support to use a narrow membership/session interface. Updated the
  affected existing performance assertion for rep support; rep setup stays restricted.
- Updated account-route and cookie/activity documentation.
- Scoped source review complete, including displayed-revision, token-refresh failure
  and terminal analytics-exclusion guards. Implementation and development sync complete.

## Verification

- Final checks: performance 37/37, targeted lifecycle 18/18, SSR 12/12;
  Svelte/tools/backend type checks, production build and loading boundaries passed.
  Existing guarantees checked include unchanged-save budgets and replay/validation,
  bounded public-document/discussion recovery, copy feedback, support admission,
  calendar/session teardown and public SSR/loading boundaries.
- No new tests or browser automation. The existing rep-support permission assertion
  was maintained for the intended behavior; setup and foreign-access refusals remain.
- Convex development sync succeeded on disciplined-squid-496, 2026-11-10 18:25 UTC,
  using `convex dev --once --typecheck enable --codegen disable`.
  No production deployment performed. Logs: /tmp/oceans-seller-{perf,lifecycle,ssr,
  convex-check,build,dev-sync}.log.
- Manual/unverified: real Clerk account switching and cross-tab sign-in, final visual
  layout, preview draft identity, seller-only support, proposal conflict/approval
  journeys and seller analytics exclusion through the deployed HTTP ingress.
