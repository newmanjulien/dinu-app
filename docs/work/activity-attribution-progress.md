# Recent activity attribution restoration

Scope: restore same-company signed-in buyer-link activity with viewer-relative
You/Colleague tags and trusted opening city. Preserve visit grouping, distinct
clause counts, retention, and copy confirmation. No new tests or browser checks.

Decisions:
- Derive optional same-company profile ID from verified Convex auth.
- Group internal visits by profile; group other visits by browser without merging
  them with internal profiles. Fence deliveries against account changes.
- Accept city only through secret intake from the opening request's Vercel header;
  normalize/bound it, omit when absent, and preserve first accepted metadata.
- Erase identity-linked current openings and their children during account deletion.
- Existing unattributed/city-less rows remain as recorded.

Evidence: `src/lib/buyer/BuyerShell.svelte`, `src/lib/buyer/activity.svelte.ts`,
`src/routes/api/buyer/activity/+server.ts`, `src/convex/buyerActivity.ts`,
`src/convex/accountDeletion.ts`, `.codex/links-activity-progress.md`.

Completed:
- Removed client/backend member exclusion; retained classification and delivery fences.
- Added verified profile attribution, separate indexed account/browser visit lookup,
  viewer-relative labels, trusted first-opening city, and bounded account erasure.
- Updated activity and erasure docs. Reviewed identity immutability, grouping,
  metadata retries, and child cleanup paths. Copy-confirmation path untouched.
- Fixed the review finding: activity ownership now includes the recognized profile
  and membership, so joining or leaving the company resets delivery with fresh
  attribution even when the sign-in session stays the same.

Validation (2026-11-12):
- `npx tsc --project src/convex/tsconfig.json --noEmit`: passed.
- `npm run test:perf`: 7 files / 39 tests passed, preserving existing saving,
  caching, startup, creation, and provider-work guarantees. No assertions changed.
- `npm run build`: passed, including Svelte check (0 errors / 0 warnings),
  tool type checks, and production client/server build.
- `git diff --check`: passed.
- After the membership-reset fix, `npm run check` passed (0 Svelte errors /
  warnings and tool type checks); `git diff --check` passed again.

Unverified: actual browser display/delivery across accounts, live Vercel city header,
and live cleanup execution. No new tests, browser automation, or deployment performed.
Workspace has substantial pre-existing changes; no unrelated work was deployed.
