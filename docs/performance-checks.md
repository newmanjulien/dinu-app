# Lightweight performance checks

Current automated guarantee reference; see the [data model](data-model.md) and
[production releases](deployment.md). Native, browser and provider behavior require
separate verification.

Run `npm run test:perf` for the performance suite. Use this same command when CI is
introduced; no CI configuration is currently added. Vitest runs saving and CSM provider tests in
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

Run `npm run test:snappiness` for the focused interaction regression checks. They also
run in `test:lifecycle` and `verify`. These use the real Svelte authoring session,
workspace, renderer, paginator, resource owners, panels, Home, creation component,
search and highlight controllers. Transport responses, animation-frame delivery,
observers and the browser measurement surface are controlled. Unrelated chrome is
stubbed; the viewer integration tests mount the actual viewer and page components.

| Interaction              | Automated guarantees                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instruction opening      | Preloads begin before renderer readiness; warm opens and close/A → B → A reuse open synchronously with no extra subscriptions. Foreground reads bypass eight occupied optional slots. Cancellation and supersession fence late opens; stale warm bodies wait for the current revision. Optional failures stay local and explicit foreground retry remains reusable.                                                           |
| Instruction preload cost | At most 64 optional records, eight optional first responses awaiting, and 4 MiB of retained encoded bodies in the exercised fixtures. Selected/editor/save pins are outside optional budgets. Warm editor demotion is recounted; byte overflow does not trigger a refetch loop. Optional arrivals leave the foreground projection unchanged. Freeze/disposal release speculative reads and released callbacks cannot publish. |
| Nearby demand            | Session refresh renews and fences reporting callbacks. The actual viewer reports semantic source order and replays its current page window to a new callback without scrolling.                                                                                                                                                                                                                                               |
| Editor feedback          | A cold anchored busy panel appears on the next Svelte update without loading copy; cancellation prevents late reopening. Warm opens skip the busy state. Save closes the editor and publishes pending annotation state while its transport response remains unresolved.                                                                                                                                                       |
| Saved contract reopening | Existing immutable-content download checks are complemented by real resource/workspace/renderer reuse. Actual viewer deactivation/reactivation preserves page element identity, snapshots and profiling work.                                                                                                                                                                                                                 |
| Concession changes       | Local intent/checkpointing update before acknowledgement; real rendering displays changed wording while saving remains unresolved. Real alternative prewarming eliminates new profiling transactions, and unchanged pages are reused.                                                                                                                                                                                         |
| Instruction-only updates | The actual mounted viewer preserves its snapshot and page elements after a compact structure/detail revision update, with zero new renderer requests or profiling transactions.                                                                                                                                                                                                                                               |
| Prepared creation        | The actual creation component adopts its prepared preview resource, source and rendered pages, with one template load and one workspace construction. Creation acknowledgement/open handoff does not repeat preparation.                                                                                                                                                                                                      |
| Home                     | Startup cards display with the live first page still pending. Visible-card warming waits for live readiness, two animation frames and deferred dispatch; scrolling pauses it through the interaction cooldown. Pending replacement search retains existing cards.                                                                                                                                                             |
| Document search          | Results publish before the DOM debounce. Repeating the query and navigating matches reuse scanned text and materialized ranges. Changed page text alone is rescanned; viewport movement limits range materialization.                                                                                                                                                                                                         |
| Overlay work             | Geometry measurement is confined to visible pages and their neighbors in the controlled viewport; revisiting measured pages reuses it. Pointer bursts coalesce into one hover check per frame. Idle and unchanged selection notifications add no work or frames.                                                                                                                                                              |

The 4 MiB assertion concerns retained encoded optional bodies, not total memory;
foreground pins and pending first-response sizes are excluded. These fixtures do
not exhaustively certify every ownership/error/save-acknowledgement interleaving.
The checks assert request counts, identity and controlled event order, not elapsed
time or frame rate. Synthetic geometry cannot establish browser layout, actual
click-to-visible latency, scroll stability, focus, mobile behavior or physical
paint. Those still require native/browser acceptance. No live requests or new
browser automation are introduced.

CSM loading has dedicated deterministic checks:

- `tests/perf/csm-availability.test.ts`: real resource coalescing, completion-based
  two-minute TTL, ready empty months, failed/unavailable eviction, eight-entry
  access ordering, A → B → A reuse, owner/invalidation/late-result fences, and a
  terminal waiter deadline with accepted work remaining reusable. Consumption
  filters elapsed starts without mutating snapshots.
- `tests/perf/csm-provider.test.ts`: real Convex auth/provider parsing with the
  installed rate-limiter test adapter and mocked fetch. Checks pre-template setup
  display vs strict new booking, foreign/rep/support/deletion/credential refusal,
  configuration/slots overlap, prompt invalid-configuration exit with slots pending,
  omitted browse duration and duration mismatch rejection, exact replay/unresolved
  adoption, fresh explicit-duration sender reads and no create after revoked access.
- `tests/lifecycle/csm-preload.test.ts`: actual shell/presentation reporter, upload
  form, widget, modal and picker in jsdom; unrelated header/status rendering is
  stubbed. Checks paint/route/mode admission, pre-template preload and visit retry
  bounds, upload dispatch before calendar work on both entry routes, Continue/open
  reuse and independent upload errors, explicit setup/support expansion with focus
  continuation, restored-support idleness, early disabled times and live receipt
  failure, unresolved-hint suppression, mismatched receipt rejection, success after
  company promotion, teardown and transport replacement.

These assert request counts and controlled event order, not elapsed-time targets.
They do not certify real Cal defaults/quotas, upload contention, achieved latency,
native modal/focus/animation/mobile/history/DST behavior or live booking/invitation
outcomes. No live provider requests or browser automation are part of these checks.
Run `npx tsc --noEmit -p src/convex/tsconfig.json` separately for backend types.

The production build also enforces SvelteKit's server-only import boundary. DOCX
parsing and Word generation live under `src/lib/server/contract`; importing them
from browser code, directly or indirectly, fails the build. Shared document logic,
upload limits, and the browser download helper remain outside that directory.

| Group      | Automated guarantees                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saving     | Identical selections return success without snapshot queries, compilation, or writes, preserving `savedAt`, revision, and `lastOperationId`. Changed zero/one-selection saves skip baseline reads and compilation, validate membership, and advance state. Replays succeed; stale saves conflict; invalid operations/revisions and missing contracts retain their behavior. A changed two-selection save confirms the read/compiler observers execute real code. |
| Scheduling | Foreground dispatches before queued background work. Aborted queued callbacks never run. Destroy rejects queued work and cancels dispatch.                                                                                                                                                                                                                                                                                                                       |
| Caching    | Compact metadata and an immutable template load once through Convex; the snapshot reopens from memory without another request, then from IndexedDB after memory release without downloading. Confirmed state updates survive reopening without rewriting the immutable snapshot store.                                                                                                                                                                           |
| Creation   | Creation writes the contract and receipt, freezes a mutable version on first capture, and adds one compact directory write without template-content reads or compilation (four writes on first capture, three when already frozen). Existing checks cover template save replay, rollback, immutable versions, import races, creation retries, and saved-version reads.                                                                                           |
| Startup    | Repeated opening requests navigate once. Returning accounts do not provision; confirmed missing state initializes once per transport generation without unnecessary initialization writes.                                                                                                                                                                                                                                                                       |

Saving observers count directory writes separately while preserving the original
contract-write assertions. Unchanged saves and replays perform zero writes to either
table; the changed-save fixture performs one contract write and one directory write.

Unchanged saves do not consume operation IDs: repeating one at the same revision
remains a no-op, and repeating it after an intervening change follows conflict rules.
This intentionally differs from changed saves, which advance revision and record
the operation. The mutation response shape is unchanged.

Tests observe work at database/compiler/storage boundaries, retain real
implementations, and restore timers, globals, cache ownership, and isolated storage.
The Node performance suite does not cover candidate deduplication, preparation
retention/eviction, cache format invalidation or exhaustive failures. The Svelte
snappiness checks above cover document reuse, search work and controlled geometry
demand, startup card presentation and warming admission; native directory
search/reactive pagination and broader adaptive device policy remain unverified. Obsolete
directory backfill/readiness paths are removed locally; there is no transition
reader to certify in the current model.
Saving races and subscription ownership have focused lifecycle
coverage in the separate Svelte suite.

These checks do not certify server Word generation, approval/export readiness in the
browser, simultaneous version consumers, or browser download behavior.

Admin authoring now uses compact certified structure, revision-authoritative details, atomic
changed-body/version deltas and baseline-lived rendering artifacts. Save publishes pending
annotation state immediately and closes the editor; workspace ownership retains submitted work
through navigation. Snappiness checks now exercise opening/preloading, immediate Save feedback
and annotation-only rendering independence, alongside the existing replay, rollback, history,
saving, scheduling, caching and account-lifecycle guarantees. They do not exhaustively exercise
the admin operation reducer, separate detail acknowledgement, recovery handoff
or extreme codec/native-capacity boundaries. Native
rehearsal and user browser acceptance remain outstanding; no latency improvement is measured.
`npm run seed:verify` additionally preserves the existing 48 frozen compositor/provenance
states and all 55 production-seed reconciliation checks, with only the intentional annotation-ID
representation adapter documented in `docs/rendering-snappiness.md`.
