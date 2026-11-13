# Setup-call bar loading

Scope: implement the approved plan without skills, new tests, browser checks, or deployment. Preserve existing unrelated working-tree changes.

Decisions:

- Start a single workspace-owned appointment read at admission, independently of page paint and optional support UI.
- Keep the visual bar small and synchronous. Use the existing read-query lifecycle; preserve valid messages during refresh/reconnect and show a local skeleton for unknown or invalidated facts.
- Separate ordinary refresh scheduling from factual invalidation. Webhooks, expiry, and conflicting provider evidence still invalidate.
- Apply bounded freshness to both scheduled and cancelled messages. Keep admission/booking qualification independent of presentation freshness.
- Bound unresolved loading with a local retry state.

Original cause: WorkspaceShell.svelte deferred bar code until presentation.canStart(); CsmSetupCallBar.svelte owned a late subscription and mount revisit; csmSetupAppointments.enqueue marked all revisits dirty; current prioritized cancellation even when dirty.

Baseline copies of touched existing files: /var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/setup-call-bar-1922u2ke

Completed:

- Workspace starts useSetupCall at admission and retains it across route changes; bar is a synchronous view.
- Shared read-query handles subscription loading/retries; provider-pending state has a 15-second local timeout/retry; freshness timers cover scheduled and cancelled notices.
- Routine revisit/repair preserves freshness and deduplicates active proof work. Actual notifications/expiry/conflicting evidence still invalidate. Existing cancellation rows use observedAt as their bounded freshness fallback.
- Reviewed modifications against the saved baseline. No admission/booking qualification changes.
- npm run test:perf passed: 7 files, 39 tests. npm run check passed: zero Svelte errors/warnings and tools TypeScript passed.
- Production build passed with npx vite build; npm run verify:loading-bundles passed for the public frame, Contracts, and buyer contract entry.
- Prettier checks passed for all four code files, and git diff --check passed for the modified existing files.

Retry review follow-up:

- Confirmed explicit retry was dropped by both local and shared 60-second revisit cooldowns. Added an authenticated explicit retry mutation that reuses pending/in-progress proof work or reserves one shared slot and schedules the existing refresh job. A maximum of one token may be reserved; denial shows the existing failure state immediately. Expired leases follow the existing repair recovery path and advance their lease immediately, fencing old results throughout any reserved wait.
- The retry response reports the scheduled wait. The local provider timeout starts after that wait, retaining a 15-second timeout for already-running work; a new reservation waits at most 60 seconds. Real evidence invalidation preempts a pending delayed refresh, while running proofs retain their generation fences.
- Confirmed reconnect/focus read-error recovery was behind the local provider throttle. Subscription retry now precedes that throttle; routine provider calls retain the existing cooldown.
- Pre-fix snapshots: /var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/setup-call-retry-before-tq1kbzon. Only csmSetupAppointments.ts, csm-setup-call.svelte.ts, and this progress file changed in the follow-up.
- After the final scheduling correction, npm run test:perf passed (7 files, 39 tests), npm run check passed (zero Svelte errors/warnings and tools TypeScript passed), and the Convex TypeScript project passed. Prettier and git diff --check also passed. Parent reviewed the final patch against the pre-fix snapshots; the production build and loading-boundary checks passed again.

No new tests added. Existing performance tests check their existing saving/scheduling/cache guarantees; they do not directly cover the bar's new display transitions or shared-slot retry behavior. Browser/provider behavior remains unverified locally. No deployment performed.
