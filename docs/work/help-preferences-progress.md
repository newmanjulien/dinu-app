# Help preferences implementation

Scope: implement docs/work/help-preferences-plan.md. User approved “go”.
No compatibility; user handles database reset before required-schema deployment.
No deployment/database changes/browser/new tests. Preserve preexisting workspace edits.

Baseline for scoped diff: /tmp/oceans-help-implementation-baseline.json; review artifact /tmp/oceans-help-implementation.diff.

Completed:
- Required profile flags/defaults, authenticated single-flag setter, private account/seller reactive DTOs; shared profile/colleague view unchanged.
- Stable HelpSession on BuyerContract and RepWorkspace; preview suppresses auto-opening, hides checkbox, leaves manual rail availability; first manual opening consumes pending auto decision.
- Account saves use authenticated transport/generation guards; actual buyers use fresh link-local namespace; storage errors reported; checkbox controlled by confirmed value.
- All direct profile insertions and affected viewer fixtures maintained.
- Existing perf suite passed: 7 files, 39 tests.

Integration detail: concurrent workspace refactor removed BuyerDocumentTools; pass HelpSession directly through BuyerDocument’s DocumentTools. Preserve the concurrent UtilityPanel refactor. Fixed its nullable visibleButton argument for build compatibility.

Validation complete:
- `npm run build` passed, including Svelte/type checking (0 errors, 0 warnings), tools TypeScript checking, Vite production build and Vercel adapter output. Log: /tmp/oceans-help-build.log.
- `npm run test:perf` passed: 7 files, 39 existing checks. Existing saving, scheduling, caching, creation, account startup and provider checks preserved. Log: /tmp/oceans-help-perf.log.
- Scoped diff review and whitespace checks passed. Traced pending/manual decision consumption, preview entry/exit, renderer remounts, confirmed identity changes, stale async guards, save failures and authenticated private response boundaries.
- Updated account-route/data-model documentation. Copy feedback path untouched.

Unverified: Help UI in browser, new setter authorization at runtime, live schema acceptance, and live cross-device synchronization. User handles browser acceptance and database reset before coordinated frontend/backend deployment. No browser automation, new tests, deployment, database changes, migration, or compatibility fallback.

Status: complete locally; ready for user review.

## Audit Q-01 remediation

User approved the audit remediation. Account preference subscriptions now remain
authoritative: successful saves no longer reapply the originally requested value
over a newer subscribed value. The preference policy requires a confirmation source;
rep and seller buyer-link policies use subscription confirmation, while actual buyers
retain save confirmation for browser-local preferences. Pending/error handling,
identity/client guards and preview behavior are unchanged.

Baseline and validation artifacts:
`/var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/oceans-help-race-fix-rjmdy8nv`.

Validation complete:
- `npm run test:perf` passed: 7 files, 39 existing saving/scheduling/caching and related checks. Log: `perf.log` in the artifact directory.
- `npm run build` passed: Svelte diagnostics (0 errors, 0 warnings), tools TypeScript checks, production build and Vercel adapter. Log: `build.log` in the artifact directory.
- Targeted Prettier check passed for the three modified source files; scoped diff reviewed against the remediation baseline.

Ran performance/build checks directly because the current `verify` script also runs
broader unrelated test suites. No new tests or browser automation. The cross-device
race and browser-local failure/retry behavior remain unverified at runtime.

Status: Q-01 fixed locally; no deployment or database changes.
