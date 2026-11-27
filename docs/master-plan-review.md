# Master plan implementation review

Status: complete, November 26, 2026. Eight findings were corrected. This reviews the completed master plan implementation and preserves the existing dirty worktree. No deployment or database reset has been performed.

## Findings

### Discussion row limits do not bound bytes — fixed

`discussions.list` permits 200 threads and 2,000 messages, while each message permits 20,000 characters. A valid discussion can therefore exceed Convex's transaction read capacity. The create/reply checks also scan existing message bodies merely to enforce a count.

The fix uses a contract-scoped capacity row to enforce the existing row limits and a 4 MiB stored-document budget transactionally. Edits respect the same byte limit. Messages awaiting asynchronous thread cleanup continue consuming capacity until their deletion, so transient orphan rows cannot exceed the bounded read. Contract and company deletion remove the capacity row.

### Refactor residue — cleaned

An additional backend TypeScript pass with `noUnusedLocals` and `noUnusedParameters` found unused credential imports, removed byte-accounting imports, old query/action imports and dead helpers. The normal type gate does not enable those flags. Removed residue in affected files. Two otherwise unchanged helpers also had three preexisting unused declarations, which were cleaned without changing behavior. The stricter check now passes.

### Unfenced quote dispatch watchdog — fixed

`hubspotQuotes.dispatch` still schedules the generic pump at the worker lease deadline. It now uses the row/timestamp-fenced wake helper already used by the other quote transitions, so an obsolete watchdog cannot start an unnecessary maintenance pass.

### Stalled Web Lock acquisition prevents cache retries — fixed

Storage callers have a 250 ms optional-read deadline, but the shared cache acquisition remained pending while a native access or metadata lock was queued. That kept the owner's `opening` promise occupied indefinitely. Acquisition now has its own 250 ms deadline, aborts queued locks and resolves unavailable without retiring the cache owner. Later reads can retry through the existing storage backoff. Native blocked IndexedDB opens still retain one request and can adopt late success.

### Failed shared-template warming never retries — fixed

Home marked a template version as warmed before its read succeeded and swallowed errors without clearing the marker. One transient failure suppressed shared-template warming for the Home owner's lifetime. Failed versions now become eligible again after five seconds on the next candidate update; pending/successful versions still coalesce. This adds no idle per-card polling.

### Stale cleanup documentation — corrected

The company deletion runbook still described removed buyer-link showing tables and a deleted resumer. Updated its phase owners and recovery instructions, documented the discussion capacity row, and removed the hard-coded tenant table count in the cleanup implementation. Historical work logs remain historical.

### Cached SDK query errors escape retry handling — fixed

Convex subscription `getCurrentValue()` throws when the cached query result is an error. The generic workspace read and authoring structure read called it outside their error handling, allowing a retained failed query to throw out of the reactive read instead of showing the region's retry state. Both now route cached failures through the same rejection path as asynchronous errors while retaining subscription cleanup. Buyer, discussion, one-shot and contract metadata hydration already handle cached errors.

### Loading fixture assumes dynamic imports settle synchronously — corrected

The final component run exposed an intermittent failure in the startup composition fixture: it asserted the private region's subscription immediately after draining Svelte microtasks. That does not guarantee the lazy authenticated account component has loaded. The isolated rerun passed, and the implementation uses an asynchronous dynamic import. The fixture now waits for the same exact subscription set with its existing bounded wait helper. Pre-auth registration, private-content gating, preserved DOM identity and mutation assertions remain intact; no coverage was added or weakened.

## Review coverage

- Inspected account authorization, startup query registration and native pagination retry behavior.
- Inspected contract metadata subscriptions, optimistic rename/remove and immutable storage ownership.
- Inspected the combined discussion query, command validation and asynchronous invalidation cleanup.
- Inspected recovery sweep discovery, delivery/quote pumps and CSM setup/preparation wakeups.
- Inspected immutable authoring batch admission, revision capacity, cancellation and retained-detail byte/count limits.
- Reviewed affected fixture/assertion diffs for changed ownership/query boundaries, batching, storage, delayed saving and provider scheduling.
- Corrected current cleanup documentation; historical work logs retain their original context.

## Verification

The prior implementation gate passed 299 runtime checks, 38 repeated performance checks, application/tool/backend types, code generation, production build and loading-bundle boundaries. These results precede the review fixes and do not validate them.

No new tests or coverage were added. Existing fixtures were maintained without weakening assertions.

| Review gate                                                     | Result                                                                                                                                                                      |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run verify`, after the first six findings                  | Passed: 16 SSR, 105 backend, 21 client and 157 component checks (299 runtime), plus 38 performance checks, application/tool types, production build and loading boundaries. |
| `npx convex codegen`                                            | Passed after the backend review changes.                                                                                                                                    |
| Backend TypeScript with `--noUnusedLocals --noUnusedParameters` | Passed after the backend review changes.                                                                                                                                    |
| Final component/performance/build/loading recheck               | Passed after the cached-error fix and fixture correction: 157 component and 38 performance checks, application/tool types, production build and loading boundaries.         |
| `git diff --check`                                              | Passed.                                                                                                                                                                     |

The existing suites check affected ownership, retry, cancellation, storage budgets, saving and provider scheduling behavior. They do not provide dedicated assertions for the new discussion byte counter, stalled native lock acquisition, shared-template warming backoff, cached SDK error getter or obsolete dispatch watchdog. Those paths were code-reviewed; passing existing suites is regression evidence, not exhaustive boundary coverage.

Browser behavior, deployed cost/round-trip measurements, native storage failure recovery and live provider acceptance remain unverified. Manual acceptance is listed in [performance-checks.md](performance-checks.md).
