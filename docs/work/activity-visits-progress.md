# Buyer activity visits

Scope: record returns only on a page opening after 30 minutes without meaningful
activity. Refreshes/tabs share a visible visit; idle tabs/polling never create returns.

Implementation: buyerActivityOpenings keeps page delivery IDs; optional visitId
points directly to the canonical opening. Canonical rows own clause summaries and
lastActivityAt. An index excludes aliases before taking the newest ten visits.
No new tables, client storage, timers or backfill. Historical rows remain valid.
Visible trusted scroll/pointer/key activity is sent at most once per minute.

Evidence: src/convex/buyerActivity.ts, buyerActivityValidators.ts, schema.ts;
src/lib/buyer/activity.svelte.ts and activity-transport.ts. Existing HTTP endpoints
already support a 204 response for non-opening activity.

Validation complete: npm run check (zero errors/warnings), npx tsc --project
src/convex/tsconfig.json --noEmit, targeted Prettier and git diff --check pass.
No new tests per AGENTS.md; no existing dedicated buyer activity suite. No saving,
scheduling or caching changes, so test:perf is not required. Runtime grouping and
browser behavior remain unverified. No deployment run: workspace contains broad
pre-existing backend edits that must not be pushed with this task.

Complete locally. Historical rows are preserved; rollout needs the optional
fields/new index and backend before clients begin sending active events.
