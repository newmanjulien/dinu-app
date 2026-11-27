# Performance and loading checks

`npm run verify` runs the existing SSR, backend, client, and component suites, then the mandatory performance suite, Svelte/application checks, strict tool checks, production build, and emitted loading-bundle checks. Backend TypeScript and Convex code generation run separately:

```sh
npx convex codegen
npx tsc --project src/convex/tsconfig.json --noEmit
npm run verify
```

Run `npm run test:perf` whenever saving, scheduling, caching, or their fixtures change. Its 38 checks repeat the relevant existing creation, saving, startup, CSM provider/availability, caching, and scheduling tests. They count work and control ordering rather than measuring production latency. No new test coverage or browser automation was introduced for the master-plan implementation.

## Existing automated guarantees

| Area                   | Checked behavior                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saving                 | Identical selections and exact replay preserve revision/timestamps with zero writes. Changed saves hydrate selected content, reject stale/invalid operations, and record one root, directory, and receipt write. Template-source work is skipped when unnecessary.                                                     |
| Creation and authoring | Canonical creation freezes a mutable version once and reuses frozen captures without template-content reads. Existing fixtures retain replay, capacity rejection, historical content, import races, immediate save feedback, exact revision adoption, optional failure isolation, and bounded detail reuse.            |
| Scheduling             | Foreground callbacks precede queued background work; aborted queued callbacks do not run; destroying an owner rejects and cancels queued work.                                                                                                                                                                         |
| Caching and warming    | Immutable templates share requests, reopen from memory and disk, and remain independent of mutable metadata updates. Existing fixtures check bounded records/bytes, cancellation, stale-result fences, source/revision freshness, and controlled warming admission.                                                    |
| Auth and SSR           | Returning accounts do not reprovision; missing accounts initialize once per transport generation. Startup streams are bounded. Saved and buyer titles use authorized server context without serializing credentials. Reads can register before auth, while private DOM remains gated and access withdrawal removes it. |
| Home and documents     | Persistent inputs/caret/debounce survive deferred results and retry. Creation/editor resources preserve canonical snapshots and page nodes, submitted operation identity, conflict recovery, and ownership across controlled navigation/replacement.                                                                   |
| Buyer and discussions  | Header-first admission, seller classification, shared link/footer behavior, copying and recovery, discussion access withdrawal, and document reuse retain their existing DOM/state/order assertions.                                                                                                                   |
| CSM                    | Availability coalescing, completed-result TTL, failed-entry eviction, owner/invalidation fences, authenticated booking and exact replay, configuration/duration refusal, revocation before dispatch, recovery proof/lease rules, and preload/receipt presentation.                                                     |
| HubSpot and exports    | Credential rotation, dispatch/settlement fences, real Workpool delivery/completion, quote uncertainty/deduplication, destination and approval checks, payload retention, uninstall/shared portals, and immutable export retries. DOCX checks generate and parse actual packages.                                       |
| Loading bundles        | The fresh emitted graph keeps document renderers, profilers, search controllers, and heavy panels outside public/persistent admission roots. Demanded document modules must still exist. SvelteKit enforces server-only DOCX imports.                                                                                  |

Saving observers count root, directory, and receipt writes separately. The exhausted-capacity fixture preserves the application's rejection guarantee; it does not certify every platform rollback boundary. Workpool's delivery fixture waits for completion before advancing fake time to future lease watchdogs, then checks retirement and exact provider request count.

Component suites use actual application ownership/admission components with controlled transport and jsdom. Assertions cover object/DOM identity, request counts, focus state, visible ordering, and cancellation. Controlled geometry and timers cannot establish physical paint or deployed network speed.

## Implementation verification

The final implementation gate passed on November 26, 2026: 16 SSR, 105 backend, 21 client, and 157 component checks (299 runtime checks), plus 38 repeated performance checks. Convex code generation, application/backend/tool types, production build, and loading-bundle verification also passed. The maintained master plan records completion and the manual acceptance limits.

Affected fixtures were maintained for membership-free read keys, pre-auth registration, shared live Home/buyer state, immutable-only disk storage, batched authoring content, combined discussion snapshots, strict setup/preferences/credentials, and event-driven scheduling. Their original guarantees remain. The suites do not add dedicated coverage for every new sweep probe, shared-cap status combination, obsolete watchdog, or native pagination split.

The [post-implementation review](master-plan-review.md) corrected eight findings and repeated the full verification gate after its backend/cache/scheduling changes. Code generation and backend TypeScript with unused-declaration checks also passed. After the final cached-error fix and loading-fixture correction, all 157 component and 38 performance checks, application/tool types, production build and loading boundaries passed again. No assertions were weakened or new coverage added. The new discussion byte counter, queued native lock timeout, shared-template retry backoff and cached SDK error getter were code-reviewed but do not have dedicated automated boundary coverage.

## Manual acceptance and limits

- Inspect cold-load WebSocket frames for authentication plus viewer/active-route registration in one round trip with no duplicate query keys. Confirm one Home bootstrap HTTP request and authorized saved-document first state/title.
- Check Home/recent-contract/Team/template warm navigation, selected authoring details, hover/search warming, buyer header-first reveal, seller preview, comments, clipboard, focus, mobile layout, selection, scrolling, and DOCX appearance.
- Check native IndexedDB/Web Lock timeout recovery and scoped multi-tab retirement; jsdom cannot certify physical cleanup after reload or storage failure.
- Inspect Convex Dashboard read counts, CPU, idle cron frequency, and exact scheduled retry/lease behavior with live providers. Confirm disabled/connection-free Journal polling stays idle.
- Exercise direct avatar uploads, Clerk lifecycle delivery, Cal booking/key rotation, HubSpot delivery/removal/quotes, and browser downloads in the intended environment.

No browser checks, live provider acceptance, production timing samples, database reset, or deployment were performed by this implementation. Existing assertions establish controlled behavior and work bounds; production round trips, cost reductions, physical layout, and provider outcomes remain unverified. Release prerequisites are in [deployment](deployment.md).
