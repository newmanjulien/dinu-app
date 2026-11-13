# Support modal preparation

Scope: coordinate booking-code, calendar, and video preparation without coupling their readiness or changing the modal UI.

Decisions:

- Extend the existing `csm-preload.svelte.ts` coordinator; keep availability caching and player lifetime separate.
- Existing background upload/Continue warming prepares booking code and calendar only.
- Explicit launcher intent also requests a YouTube preconnect; mount the player only in the open dialog.
- Preserve replacement-status gating, unresolved-booking suppression, cache ownership/expiry/invalidation, and fresh-player teardown.
- Do not create or expand tests, use browser automation, or change Convex code.

Evidence: `docs/delegation.md:53`, `CsmDialogHost.svelte`, `csm-preload.svelte.ts`, `csm-availability.ts`, and the existing CSM lifecycle/performance suites. Browser preconnect reference: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/preconnect

Completed:
- Traced current entry points, eligibility/paint gates, and caching/player lifetimes.
- Extended `warm` with explicit upload/video options, a live-owner preconnect hint, and replacement-read gating.
- Connected launcher hover/focus/expansion and admitted modal opening; removed the duplicate eager import from the dialog controller.
- Kept player mounting/teardown and calendar caching separate; updated `docs/delegation.md`.
- `npm run test:perf`: 7 files / 37 tests passed (cache reuse/expiry/eviction, stale ownership, invalidation, scheduling, saving).
- Existing `tests/lifecycle/csm-preload.test.ts`: 13 tests passed (paint gates, upload ordering, shared reads, receipt gating, reopen, session replacement).
- `npm run build` passed, including Svelte/application checks (zero errors or warnings), tools type checks, client/server production compilation, and Vercel adapter output.
- Vercel adapter emitted dependency-tracing warnings for generated `.svelte-kit/output/server/*.ts` references; command still exited successfully. Full build output: `/tmp/oceans-support-build.log`.
- Targeted diff whitespace check passed. No tests added or expanded.

Complete: implementation, documentation, existing performance/lifecycle checks, production build, and final diff review. Existing tests do not assert the new preconnect hint or real YouTube readiness; actual YouTube/provider latency and browser appearance remain manual checks.
