# Lightweight performance checks

Run `npm run test:perf` once for all five performance test files (24 tests). Use this same command when CI is
introduced; no CI configuration is currently added. Vitest runs saving tests in
the edge runtime through `convex-test`, and scheduling/cache/startup tests in Node with
controlled browser callbacks and fake IndexedDB. Fixtures are synthetic; no browser
harness, backend, seed data, or elapsed-time thresholds are required.

Run `npm run verify` to run the lifecycle suite, performance suite, type checks and
production build. `npm run test:lifecycle` uses compiled Svelte components and
controllers in jsdom with controlled transport responses and a lightweight viewer.
It checks route teardown, background writes and rapid reopening, early metadata
acknowledgement, journal and approval identity, recovery deadlines/concurrency,
account flushing, transport replacement, company holds, deletion/discard, creation
retry, and attachment cleanup. It does not drive a browser or emulate SvelteKit's
history implementation; the manual navigation checklist is in `docs/lifecycle.md`.

The production build also enforces SvelteKit's server-only import boundary. DOCX
parsing and Word generation live under `src/lib/server/contract`; importing them
from browser code, directly or indirectly, fails the build. Shared document logic,
upload limits, and the browser download helper remain outside that directory.

| Group      | Automated guarantees                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saving     | Identical selections return success without snapshot queries, compilation, or writes, preserving `savedAt`, revision, and `lastOperationId`. Changed zero/one-selection saves skip baseline reads and compilation, validate membership, and advance state. Replays succeed; stale saves conflict; invalid operations/revisions and missing contracts retain their behavior. A changed two-selection save confirms the read/compiler observers execute real code. |
| Scheduling | Foreground dispatches before queued background work. Aborted queued callbacks never run. Destroy rejects queued work and cancels dispatch.                                                                                                                                                                                                                                                                                                                       |
| Caching    | Compact metadata and an immutable template load once through Convex; the snapshot reopens from memory without another request, then from IndexedDB after memory release without downloading. Confirmed state updates survive reopening without rewriting the immutable snapshot store.                                                                                                                                                                           |
| Creation   | Creation retains two contract/receipt writes and adds one compact directory write without template-content reads or compilation. Existing checks cover publication replay, rollback, immutable versions, import races, creation retries, and saved-version reads.                                                                                                                                                                                                |
| Startup    | Repeated opening requests navigate once. Returning accounts do not provision; confirmed missing state initializes once per transport generation without restarting attribution.                                                                                                                                                                                                                                                                                  |

Saving observers count directory writes separately while preserving the original
contract-write assertions. Unchanged saves and replays perform zero writes to either
table; the changed-save fixture performs one contract write and one directory write.

Unchanged saves do not consume operation IDs: repeating one at the same revision
remains a no-op, and repeating it after an intervening change follows conflict rules.
This intentionally differs from changed saves, which advance revision and record
the operation. The mutation response shape is unchanged.

Tests observe work at database/compiler/storage boundaries, retain real
implementations, and restore timers, globals, cache ownership, and isolated storage.
The performance suite does not cover candidate deduplication, preparation
retention/eviction, cache format invalidation, exhaustive failures, document reuse,
or search/geometry. The server startup snapshot, directory backfill/pagination
transition, and adaptive device/interaction policy have no dedicated coverage.
Saving races and subscription ownership have focused lifecycle
coverage in the separate Svelte suite.

These checks do not certify server Word generation, approval/export readiness in the
browser, simultaneous version consumers, or browser download behavior.
