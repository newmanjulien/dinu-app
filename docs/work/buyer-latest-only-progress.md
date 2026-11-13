# Buyer links: latest publication only

Scope: remove buyer version browsing and token-authorized historical access; preserve authenticated seller history, publication records, and discussion ownership. No schema migration.

Decisions:
- Public status/content resolve only the current publication.
- Seller content supports selection only after membership authorization.
- Buyer/preview URLs discard publication/version selectors.
- Buyer discussion access requires the current publication; sellers retain historical discussion reads.
- Preserve live publication updates, download freshness checks, and buyer link copy feedback.

Evidence: buyerLinks.resolve/contentV2; contractPublication.history/sellerHistory; discussionContext; BuyerShell; BuyerContractPage; BuyerUtilityRail; ContractVersions. Original touched files saved under /tmp/oceans-buyer-latest-before for scoped review of a dirty workspace.

Progress: implemented latest-only public reads, deleted public history query, gated historical discussions, moved seller history/content/discussions to authenticated transport, stripped buyer URL selectors, removed dead rail/panel version controls, simplified seller-only ContractVersions. Updated data model docs. Initial npm run check passed (0 Svelte errors/warnings, tool typecheck passed).

Next: focused existing loading/recovery checks, production build, backend typecheck/dev push, scoped final diff review. No new tests or browser checks.

Checkpoint: production build passed; 5 existing loading/recovery checks passed; backend tsc passed; dev push succeeded on disciplined-squid-496. Dev push also applied pre-existing/concurrent activity schema index changes from this workspace. Final access review identified proposal undo reading a historical source via buyer token; moving seller proposal actions to membership access to retain undo semantics. Final validation pending after that adjustment.

Complete:
- Seller proposal accept/undo now use membership-scoped discussion access; current-only acceptance and historical-source undo remain enforced by their original checks.
- Final npm run build passed (Svelte check: 0 errors/warnings, tools typecheck, production build).
- Backend standalone tsc passed; final convex dev --once --typecheck enable succeeded on dev:disciplined-squid-496. No production deployment.
- Existing loading-recovery suite: 5/5 passed (read timeout/cancellation, discussion access rejection, buyer resource recovery, copy feedback).
- npm run test:perf: 39/39 passed across 7 files, preserving existing saving/scheduling/caching assertions. No test changes.
- Scoped diff reviewed against /tmp/oceans-buyer-latest-before; final snapshot /tmp/oceans-buyer-latest.diff. git diff --check passed; no remaining buyer history API/rail references.
- Browser flows, live buyer/seller role transitions, and runtime authorization-denial cases were not exercised. No new tests or browser automation.
