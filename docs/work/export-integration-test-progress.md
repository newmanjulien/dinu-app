# Export and integration coverage

Scope: Add regression tests for the seven gaps identified in the read-only review: real DOCX output, buyer download races, Quotes, uninstall/reinstall, credential refresh, seller download flow, and approval gates. No browser or live-provider calls.

Use the existing Vitest/convex-test fixtures. Preserve all pre-existing workspace changes. Prefer tests through public actions and real in-memory mutations; mock only external/provider and presentation boundaries.

Completed:
- Added real DOCX package checks for composed wording, legal numbering/bookmarks, references, tables, signature layout instructions, Unicode and line breaks.
- Added real Word action tests for immutable retries, hashes, approval admission and approval changes during generation.
- Added buyer endpoint tests using real in-memory authorization and real Word generation, plus buyer controller cancellation/timeout tests.
- Added Quotes push/send/readback tests for deduplication, ambiguous creation, altered terms/deal/type/archive, admission, payload limits and reservation ownership.
- Added credential refresh tests for rotation, concurrent ownership, transient recovery and revoked refresh tokens.
- Added removal/reinstall tests for activity/Quotes retirement, attachment holds, contracts, old OAuth callbacks, shared portals and admin authority.
- Added mounted seller workspace tests for save ordering, pending retries, failed-fetch retries, acknowledgment order and navigation/session/approval/unmount cancellation.

Findings fixed in `src/convex/hubspotQuotes.ts`: compare reservation JSON by canonical value rather than object field order; strip link availability before saving a provider destination. Both failures were reproduced by the new real workflow tests. Existing ownership checks remain covered by another-actor and tampered-content refusals.

Validation complete: 53 new cases (38 integration, 15 lifecycle), all passing.

- `npm run test:hubspot`: all 87 tests pass, including the existing 49 tests. Log: `/tmp/oceans-export-integration-hubspot.log`.
- Targeted buyer/seller download lifecycle suites: all 15 tests pass. Log: `/tmp/oceans-export-integration-lifecycle.log`.
- `npm run test:perf`: all 36 tests pass. Log: `/tmp/oceans-export-integration-perf.log`.
- `npm run check`: zero errors/warnings, including tool types. Log: `/tmp/oceans-export-integration-check.log`.
- `npx tsc --noEmit -p src/convex/tsconfig.json`: passes. Log: `/tmp/oceans-export-integration-backend-types.log`.
- `npm run build`: passes. Log: `/tmp/oceans-export-integration-build.log`.
- `npm run verify:loading-bundles`: passes. Log: `/tmp/oceans-export-integration-loading-bundles.log`.
- `npm run verify`: stops in the existing lifecycle test `tests/lifecycle/document-snappiness.test.ts:42`; its resource fixture supplies a null source to `DocumentRenderController.request` (`renderer.svelte.ts:196`). Reproduced by running that existing file alone, without any of the new tests. Full run: 86 pass, 1 fail before the final timeout test was added. Logs: `/tmp/oceans-export-integration-verify.log`, `/tmp/oceans-export-integration-existing-failure.log`. No changes made to that unrelated fixture or implementation.

No remaining task work. Live HubSpot behavior, actual browser downloads and Word's visual rendering remain unverified. No live provider calls, deployment or browser checks.
