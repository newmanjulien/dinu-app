# Persistent document preparation

**Historical implementation/evidence record, superseded for current backend instructions on 2026-10-30.** The [current architecture](backend-redesign/architecture.md), [17D2 local evidence](backend-redesign/phase-17d2-cross-workflow.md) and [Phase 18 activation procedure](backend-redesign/phase-18-activation.md) own present behavior/status. Older counts, formatting, indexes, attribution, probes and deployment results below describe their original revision; they do not certify the changed backend or authorize an old rollout recipe.


The app layout owns the shared live Admin queries, the DOM measurement
surface, and `DocumentResources`. Each resource retains one source controller,
document domain, renderer, viewer state, and mounted `DocumentPage` elements.
`RetainedViewer` moves the same wrapper between its offscreen parking element and
the open route's `DocumentViewerSlot`. Opening a valid prepared document does not
construct another source, compose, paginate, or remount its pages. The browser
still paints those elements when they become visible.

Admin authoring sessions, saved-contract persistence, editors, search, selection
tools, and navigation guards belong to the open route. The slot passes their
current settings and panel snippet to the retained viewer. The route activates its
resource before its slot mounts, so initial query failures cannot evict the source
still owned by the open route. Departure clears those bindings after the existing
save/discard guards finish. Dormant viewers are inert and hidden from accessibility
APIs; they release highlights, interaction
listeners, focus callbacks, and scroll effects, and do not publish active readiness.
Their page content keeps the same physical dimensions. Visible scaling and panel
layout are measured after activation.

## Scheduling and candidates

The app layout starts shared Admin queries and code preloading, but saved
snapshot retrieval and preparation do not wait for Admin. Admin source acceptance
and document preparation run in background only while the saved queue is empty;
foreground navigation wins at scheduler boundaries.

Home and search use one viewport observer. Every visible card queues snapshot
retrieval, with at most two background retrievals at once. Preparation ranks hovered
or focused cards first, then contracts most recently opened on this browser, then
most recently saved, then server card order. Display order stays unchanged. A
successful navigation records its contract once, after current pages are visible
and ready; localStorage retains the most recent 50 IDs and timestamps. Hovers and
background preparation do not record openings.

Only the highest ranked bounded candidates prepare, one saved document at a time
through idle scheduling. The most recently opened retained viewer reserves a slot.
Pending searches keep the old cards visible and pause new automatic preparation;
hover and navigation still promote those cards. New results and viewport departures
cancel queued retrievals and unfinished preparation for disappeared cards. Completed
viewers may remain within the retention budgets. Navigation guards run before the
destination is promoted and protected through route handoff.

`DocumentScheduler` dispatches foreground work before document preparation, then
concession-alternative warming. Composition and layout preparation yield between
blocks with a four-millisecond slice target. Background profiling measures one
block at a time, and background mounting adds one page per slice. The mounted-page
list is clamped on every snapshot change, so shrinking and regrowing a document
cannot mount multiple new pages ahead of the scheduler. Foreground work preempts
background work between slices. A source build, single block, or pagination pass can
exceed the slice target, so browser long-task measurements remain necessary.
Speculative slices and new snapshot downloads pause while the tab is hidden.
Alternative geometry warming runs only for the active viewer after document
preparation, and background profiling does not replace its protected geometry.

## Validity and retention

Before initial visibility, the viewer checks the exact published source object,
selected concessions, preview changes, and current layout epoch. Revision numbers
alone cannot identify separate documents. Prepared-page readiness also waits for
the Svelte DOM update. Active interaction readiness and the first visible paint
opportunity are separate milestones.

The saved route returns an ID and loading shell.
`SavedContract` starts browser snapshot retrieval and one live Convex state query
concurrently. That query remains the workspace's state source throughout editing;
there is no HTTP state check or second workspace state subscription. Cached content
can prepare offscreen while validation runs. Confirmed selections are applied before
activation, and exact renderer readiness prevents stale pages becoming visible.
Initial loading, errors, retry, deletion and editing conflicts remain route-owned.
The creation dialog stays pending until the new document is visible and ready, and
keeps its created ID for a failed-opening retry. Its optional preview consumes the
shared baseline/playbook queries; creation still captures its authoritative snapshot
in the existing backend transaction.

The manager retains Admin plus at most four saved viewers, including active and
opening documents. It favors the most recently opened viewer, visible higher-ranked
candidates, and recent use when evicting inactive viewers. Inactive saved viewers
retain at most 60 pages combined; active/opening pages are excluded. Failed or
budget-evicted candidates release their preparation slots to the next ranked cards.
They do not retry automatically during the same candidate visit; explicit hover,
focus and foreground opens can retry. The shared profiler retains only a geometry
ownership token and releases protected geometry when its renderer is destroyed.
These are conservative defaults, not measured optima for Home responsiveness.

The independent memory and IndexedDB caches each retain at most 24 immutable
snapshots and an estimated 32 MiB of JSON data. Retrieval tries memory, disk, then the
existing full-snapshot endpoint. Confirmed metadata accompanies snapshots; local
selection drafts and pending operations never enter storage. Memory eviction keeps
the disk copy. Default Home card metadata caches the first 24 results in localStorage
for 24 hours and renders only inside the app layout. Live results replace it;
pagination is disabled until the current live result is ready. Searches retain cards
through debounce and loading, with skeletons only when no cards are available.
All storage names include deployment URL and format version. Invalid or unavailable
storage falls back to normal loading. Snapshot validation also checks block and item
counts against the stored arrays. IndexedDB stores immutable content separately
from contract metadata; confirmed state updates and LRU scans touch only metadata,
and reads do not wait for the queued write chain. The version 2 disk format rebuilds
the previous combined cache on demand. A failed search settles the loading state
and resumes preparation of retained cards while pagination remains disabled.

Successful rename reconciles cached metadata and cards. Confirmed deletion removes
memory/disk snapshots, retained viewers, cached cards and opening history, and
in-flight work cannot restore deleted data. Layout teardown destroys renderers,
mounted viewers and queued work; persisted storage survives. Browser resources are
never shared between SSR requests. Future authentication can scope storage by user.

`PUBLIC_CONTRACT_DOCUMENT_PREPARATION=0` disables full document preparation and
retention independently of shared geometry profiling. `PUBLIC_CONTRACT_ROUTE_PROFILES=0`
preserves the viewer-owned measurement fallback and also disables full document
warming. Embedded viewers use their existing local fallback. No backend change or
deployment is required for document preparation.

## Manual verification

Type checking, a production build, and formatting checks cover the implementation.
The browser checks and timing comparison below have not been run in this workspace:
the agent environment has no browser inspection tool. No tests or browser automation
were added. Do not treat the checklist as measured evidence.

- Refresh Home with cached cards, throttle live queries, and confirm pagination is
  disabled until live results arrive. Search through debounce/loading, including
  empty results and failures, and confirm cards remain visible until results settle.
- Inspect IndexedDB and the network on a persistent-cache hit: no full snapshot
  request should occur. Disable storage and repeat direct visits and creation.
  Check one live saved-state subscription, fresh selections before display, and
  mutation reconciliation. Remove/corrupt entries and confirm network fallback.
- Compare hover/focus, browser opening history and saved-time preparation priority
  on Home and changing searches. Confirm history records only successful displays
  and that hidden tabs suspend new downloads and speculative slices.
- Open prepared Admin and each Home candidate, then reopen the same contracts.
  Check layout, annotations, search, editor placement, and page-element identity.
- Open an unprepared contract directly and during Admin or contract preparation.
  Confirm normal loading/error states and that foreground work continues promptly.
- Fail Admin's initial queries while its route is open, then recover them. Confirm
  the route keeps the same source and receives subsequent live updates.
- Change live Admin data while Admin is active and inactive. Shrink and then grow
  an inactive document and confirm each added page waits for an idle slice. Depart
  with a preview, then return; verify the canonical document and fresh authoring session.
- Exercise Admin save/discard cancellation and saved-contract save-before-leaving,
  failure, retry, discard, and Back/Forward guards. A cancelled departure must leave
  the active viewer and editor intact.
- Change selections in another tab before reopening a prepared contract. Check
  updated pages before initial visibility. Repeat with a name-only change and verify
  page reuse. Exercise the existing conflict/Load latest flow while editing.
- Delete a prepared and an active contract. Confirm missing/deleted UI and eviction
  from both caches. Retry failed downloads and background rendering through a normal open.
- Trigger a font loading cycle while warming and while active. Verify stale layouts
  cannot become ready, and the active document renders before speculative work.
- Open five saved contracts to exercise viewer eviction, and open a document above the
  60-page inactive limit. Confirm the active viewer stays protected and data-cache
  hits remain possible after its hidden viewer is released.
- Scroll candidates out of view, leave Home mid-preparation, hide/show the tab, and
  leave the app layout. Check cancellation, resumption, and listener/DOM cleanup.
- Repeat basic opens with each fallback flag disabled.

## Timing and reuse comparison

Performance recording is enabled in development or with `PUBLIC_CONTRACT_PERF=1`.
Use the same browser, documents, viewport, and settled fonts for two local runs:
default preparation enabled, then `PUBLIC_CONTRACT_DOCUMENT_PREPARATION=0`. Keep
geometry profiling enabled in both. Include cold direct visits with cleared caches,
warm memory opens, and warm IndexedDB opens after reload. Use network inspection to
confirm retrieval behavior. Progressive rendering after opening is outside this
change and should be assessed separately if cold visits remain slow. Restart the local app and reload between runs.

Wait on Home for the ranked candidates’ page-element milestones, then record at
least five opens/reopens of the same contracts without changing their selections
or source. For each open, save the navigation-to-ready and first-visible-paint
durations, source/renderer construction counters, and render requests since the
click. Also record Home warming duration, long-task count, total duration, and
maximum duration for comparable Home visits. Report the individual samples and
median navigation time for each run, plus additional Home long tasks with warming
enabled. Do not interpret an unsupported long-task observer as zero long tasks.

Browser inspection records are bounded and contain no contract text:

- `window.__contractColdStart`: background preparation start/ready, background and
  active page-element readiness, prepared/unprepared acquisition, element reuse,
  active interaction readiness, navigation-to-ready duration, and the first visible
  paint opportunity. The paint mark is an opportunity after a frame, not proof of
  pixels painted or a Largest Contentful Paint measurement.
- `window.__contractStartupPerf`: workspace/renderer construction and source acceptance.
  Acceptance may revalidate unchanged input; a valid prepared open must not build
  another document domain/source index.
- `window.__contractDomainPerf` and `window.__contractRenderPerf`: source compilation
  counters and per-request composition, preparation, profiling, pagination, commit,
  and cancellation metrics. Render samples retain their initial priority, including
  when background work is subsequently promoted.
- `window.__contractHomeWarmingPerf`: Home start/end and bounded long-task records,
  with `longTasksSupported` indicating whether the browser supports observation.

In DevTools, capture the prepared viewer's page elements before opening it (including
offscreen elements), then compare them by identity after activation and after a
reopen. Do not keep these references beyond the comparison, since DevTools references
can themselves prevent eviction from releasing memory. A valid prepared open must
reuse every page element and add no source construction, composition, or pagination
work for that document. A cache hit or a reuse mark alone is insufficient evidence.

See [domain implementation and verification](document-domain-runtime.md),
[editor lifecycle](lifecycle.md), and the historical
[cold-start performance evidence](cold-start-performance.md).
