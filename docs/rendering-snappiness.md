# Contract geometry compilation and pure pagination

The renderer composes provenance-preserving blocks, prepares stable tokens, resolves
browser geometry, and runs one resumable paginator with internal page-boundary checkpoints. Initial openings
publish exact closed pages before remaining pagination finishes; the complete
`RenderSnapshot` adopts those frozen page objects. Warm updates retain the displayed
complete document until their complete replacement commits. A cache-only render never
touches the profiling DOM. See [verification and limits](#verification-and-limits) for automated checks and
remaining browser acceptance limits.

## Composition and preparation

The workspace source controller owns a baseline-scoped artifact store shared with rendering and concession warming.
Composition engines keep their own source index, Trigger lookup, numbering metadata,
dependencies and cursors. Completed container content and resolved blocks are interned
using complete content/provenance versions; preparation engines share weak caches of
prepared blocks and cell tokens while keeping request counters private. Current-document
artifacts and their dependency closure are protected. Other completed container/block
roots share a fixed 256-entry LRU, so optional block retention cannot exceed 256 variants.
The store owns a reference-counted dependency graph, with request-local working references
released on completion, failure or cancellation. Foreground working references survive
pagination until the complete snapshot promotes its current artifacts. Composer fields
hold no independent container, generated-content or resolved-output caches. Replacing the
baseline or destroying the workspace source releases the store; layout epochs and content
source changes borrow it without clearing completed artifacts. Cancelled work can
contribute completed optional artifacts without publishing a snapshot.

Runtime container versions include active patches, view and applicable numbering/reference
addresses, including references introduced by replacements. Ordered structural transfers,
incoming suffixes and cutoffs reference immutable input artifact IDs and transfer intervals.
Resolved versions reference those artifacts before constructing output, avoiding expanded
run/provenance serialization on warm hits. The same complete version path handles every
request, including removal of a previous transfer. Synchronous one-shot consumers keep only
request-local artifacts and skip resolved-output interning.

`LayoutPreparationEngine` reuses prepared blocks by resolved identity, including
whole static tables. Each cell produces a plain display token without source
coordinates; there is no cell-level preparation cache. Table geometry uses raw
cell text, header count, and variant. Text-block geometry fingerprints include
text, revisions, line anchors/breaks and layout-affecting fragment properties. They exclude source
coordinates and generated offsets, which remain on current tokens. Matching geometry
permits profile reuse; matching prepared content identity permits page reuse.

Live authoring removes the entire selected range and adds the complete replacement.
Saved concessions may use a bounded readable redline. Effective wording, source slices,
generated offsets and annotations follow the rules in
[the data model](data-model.md).

## Annotation updates

`DocumentDomain` accepts compact structure separately from hydrated selected details.
`/admin` subscribes to `currentStructure` and keeps a bounded live instruction-detail pool.
It starts warming as soon as the baseline matches ready structure, independently of renderer
readiness: all fitting instructions, with 64 optional entries, eight first responses in flight
and a 4 MiB encoded retained-body budget (not a total-memory bound). Selected/editor/save
targets are pinned outside those optional limits. Completed owner transitions immediately
account for demoted records in the optional budget; pending switches retain the actual editor
pin. Closing or switching retains warm details; the last eight admitted real selections/opens,
including successful existing-item restores, and nearby pages take priority over remaining
structure order.
Nearby demand reuses `subscribeEagerPages` and complete semantic annotation-owner memberships,
including boundary and grouped controls, without extra page observers or text measurement.
Memberships rebuild after owner commit, including boundary controls returning from location
picking, and sort by page and semantic source position before deduplicating the current window.
Each eligible reporting lifetime receives the current eager-page replay, including stationary
same-baseline read restarts; retired callbacks cannot change current demand.
Only selected/save-confirmation records enter the stable hydrated-detail projection. Optional
arrivals do not notify foreground authoring reconciliation, change document render identity or
paginate. Optional errors remain local to warming; accepted successful current reads retire
only their own failed-read suppression. Deactivation, pause, blocking, freezing, suspension and
baseline mismatch release optional work and nearby reporting; any released/recreated read
requires a fresh observation.
Successful structure acceptance memoizes the exact immutable
array, pending render key, compiled contract identity and certification mode; detail hydration
continues independently. Failed acceptance invalidates that shortcut. Certified structural
snapshots build interval buckets in one
pass, avoiding repeated audits of unchanged neighbors. Baseline blocks and their fingerprint
arrive atomically; authoring readiness requires matching current structure. Detail readiness
also requires an authoritative successful watermark and matching revision. An unavailable
detail is loading/error, not proof that its rule was deleted. Warm selections reuse their
existing current live snapshot synchronously; cold selections wait in the anchored rail/sheet
without adding a loading row or changing document height. Editing copy can continue while
a wording preview lays out; new source selection requires the coherent displayed snapshot.

Only active replacement effects contribute to `ContractRenderSource`. Annotation-only
updates retain that source, prepared tokens, pages and `selectionDocument`; they schedule no
composition, token preparation, paragraph profiling or pagination. Actual wording changes
reuse the baseline artifact store and compatible pagination history. Admin alternative warming
requires an open panel, so confirming an instruction does not start optional layout work.

`DocumentAnnotationProjection` indexes mounted token provenance once per complete snapshot
and projects changed annotation ranges over the shared highlight controller's measured line
maps. It handles baseline source, removed runs, generated replacement intervals, repeated
occurrences and structural aliases. Every valid mounted occurrence has a named out-of-flow
keyboard owner in source/priority order, with Enter/Space and selected/disabled states,
even before its highlight geometry is measured. Complete clipped source/generated coverage
determines focus restoration. Cold owners use a nonpainting page-local fallback; focus
prepares only that owner's page. Native cold focus reveals measured bounds, while
programmatic restoration preserves scroll. Deferred measurement never restores focus or
reveals after a newer user intent. Bounds lookup uses the group's own pages, and ordering
runs only when membership, anchor, identity or priority changes. Pending/selection state
updates paint and ARIA independently.
Pointer hit testing uses exact projected intervals and existing drag/selection/obscuring-UI
policy. Annotation IDs use immutable render keys, so a pending new item keeps its semantic
owner after the database ID arrives. Pending targets have dashed paint and disabled activation.
Structural gaps use their existing independent controls. Annotation DOM and state changes do
not invalidate text layout; font/content changes retain the existing geometry invalidation.

## Browser geometry compilation

The app layout mounts a persistent `LayoutProfileSurface` and provides its `LayoutProfiler`
to route viewers. A standalone viewer, or `PUBLIC_CONTRACT_ROUTE_PROFILES=0`, uses the
original viewer-local host. The profiler
serializes surface access and resolves cached geometry by fingerprint. Opening, updates and concession warming all follow paginator geometry requests.
They consult request-local and cached geometry before measuring a missing block;
a bounds read can immediately upgrade to exact geometry against that same DOM.
Only splitting and heading lookahead require paragraph lines. The surface interface
explicitly forwards `bounds` or `exact`; surface transactions remain synchronous and serialized.
Request-local associations use current prepared objects and survive cache eviction. `LayoutProfileCache` retains all shapes in the latest resolved document and a
256-entry LRU of other shapes for one layout epoch. Idle alternatives cannot evict current
geometry, including in documents larger than the LRU. The cache validates and freezes
explicit geometry fields without retaining content or provenance. Each fingerprint has one
entry per epoch: exact profiles satisfy bounds requests, and an upgrade updates protected
and ordinary entries. Bounds never replace exact geometry, including when several current
blocks share a fingerprint or retained request associations are reactivated after eviction.

The hidden, inert surface renders production `BlockFragment`, inline, revision and source
components at contract content width. Profile mode retains layout wrappers while suppressing
heading IDs, focus semantics and Trigger activation. Each source leaf carries an unconditional
`data-contract-token` marker. Hidden leaves omit unused source-coordinate and interaction
attributes by default; `PUBLIC_CONTRACT_PROFILE_METADATA=1` restores them. Visible leaves
always retain all selection and provenance metadata. Text, source spans, revision wrappers and layout classes remain identical. Annotation
activation owners sit outside the text flow and never appear on the profile surface. A synchronous scoped operation
mounts one block, reads its geometry, lets pagination request immediate detail, and clears
it before returning, including on failure. The surface is never held across an asynchronous
wait. Tables still use the additional canonical-column write/read pass before affected
pages can close.

Profiles contain fractional CSS-pixel geometry:

- Headings retain their complete outer height.
- Paragraph bounds retain actual content height, margins and token count. Whole paragraphs
  can fit without reading line boxes only when conservative production DOM, token and CSS
  checks establish support. Splitting and heading lookahead request exact profiles;
  unsupported bounds structures fall back to exact profiling. No line geometry or token
  boundaries are inferred by dividing height by line height.
- Exact paragraphs retain contiguous, half-open token ranges for browser-observed visual lines.
  Allocated line boxes include line-height leading; glyph rectangles alone do not define
  fragment heights. Collapsed whitespace keeps its tokens without allocating a line;
  an empty insertion slot can allocate one unsplittable line.
- Tables retain canonical column widths, repeated-header height, whole body-row heights,
  margins and explicit outer border contributions. Every fragment uses those columns.

Preparation exposes ASCII-hyphen boundaries while preserving characters and provenance.
A remaining token spanning multiple visual lines fails explicitly. Validation checks
numeric geometry, line order, token coverage, columns and rows. The 0.01 CSS-pixel tolerance
compares equivalent observed coordinates only; page-fit arithmetic has no overflow allowance.

The surface publishes readiness after fonts settle. Font loading immediately invalidates
retained handles, and completion publishes a new epoch. Epochs distinguish surface mounts
as well as layout policy. The profiler checks the live epoch before and after profiling
and rejects stale results before cache insertion. A new epoch prevents old page reuse.

## Pure pagination and reconciliation

`iteratePreparedDocument(blocks, profiles, options)` is DOM-free and resumable. It yields
geometry requests, cooperative checkpoints and closed pages whose placements later blocks
cannot change. Heading lookahead and canonical full-table measurement precede page closure.
`paginatePreparedDocument()` remains a synchronous wrapper for existing callers. Both use
request-local geometry without cache access. The incremental driver compares prepared
sequences and restarts at the first page containing the immediately preceding block.
A preceding heading can restart one page earlier because changed lookahead may let it move back.
Earlier pages remain intact. Checkpoints contain page number, next prepared block identity,
and paragraph-token/table-body-row offset. A matching boundary at the same page number,
with an identical remaining prepared sequence, reuses the old suffix. History is eligible
only for the same source and layout epoch; unavailable checkpoints restart at page one.
The synchronous wrapper retains full pagination behavior.
Paragraphs split only at complete observed lines. Each fragment retains its start margin;
only the final fragment includes end spacing. If final spacing does not fit, the last line
moves with it. Headings keep with the next paragraph's first actual line, including final
spacing when that paragraph has one line.

Tables move whole to a fresh page when they fit there. Larger tables split only between
whole body rows and repeat original headers under canonical columns. Header-only tables
remain supported. An oversized visual line, heading/first-line pair, or table
header-plus-row fails with a technical layout error.

Each page has ordered placements associating prepared content with fragment kind,
interval and presentation. `iterateReconciledPages()` reconciles each closed page once
with its absolute page offset, then freezes it for publication and final adoption. At
the same page position and epoch, equal prepared identities, intervals and presentation
retain the previous page object. Table column values must also agree. Moved or differently
sliced content keeps the candidate page. Changed page numbers include removed pages.

## Complete snapshots and interactions

`ContractRenderController` serializes requests and checks generation and live epoch after
profiling and immediately before committing, including after commit listeners. The same
currentness check runs when queued profiling starts and before inserting its results, so
cancelled or superseded requests skip pending DOM work. A pending job records request
identity, source, selections, preview, epoch, finished pages and running/failed status.
Partial pages never become a `RenderSnapshot`. A published complete snapshot contains accepted source, concessions, preview changes, pages, epoch and changed
page numbers. Page records, placement records and their arrays are frozen at publication;
prepared content follows the immutable input contract.

Initial openings include reactivating retained pages that disagree with confirmed intent.
They show the first eligible exact page, append one available page per paced slice, and
show “Preparing remaining pages…” at the tail. Document height comes from mounted pages;
completion does not bulk-mount a backlog. Fully mounted matching retained contracts display
immediately. Every append validates generation, source identity, selections, preview, epoch
and preparation eligibility. Invalidation, cancellation and eviction clear partial work;
partial pages count toward inactive retention budgets.

Before first display, pagination retains four-millisecond preparation slices and stops at
its first closed-page publication. The viewer mounts that page alone, awaits its Svelte tick
and a frame followed by a task, then acknowledges the matching generation and layout epoch
outside serialized work. Visible preparation and individual page appends subsequently share
an eight-millisecond deadline starting in a task after a frame. Queued appends take precedence
within paced work, and their awaited DOM flushes count toward the same window. More work can
run while time remains; an indivisible measurement or mount can overrun. Explicit warm updates
dispatch immediately and remain atomic; speculative preparation uses idle dispatch.

Scrolling and native selection work during partial display. The highlight controller attaches
after the first paint opportunity, receives appended DOM changes and survives completion.
Clause activation, authoring and search require the complete current document to be mounted.
Snapshot consumers use `displayedSnapshot`, which is empty during partial opening; search
continues against the displayed complete snapshot during warm updates. Warm requests and
failures retain that complete document and its existing reconciliation and viewport anchoring.

The first exact display closes creation once; full readiness records opening history
separately once. Failure before first display reports an opening failure. Failure afterward
retains eligible finished pages and shows an explicit incomplete-document error with Retry.
Retry renders current valid source and intent; failed partial work never counts as complete.

Page-number keys preserve unchanged DOM. Highlights refresh changed page geometry and retain
unchanged range contributions; hover and pressed-state updates affect paint separately.
Search updates changed source blocks, retains unchanged ranges and performs no traversal
for an empty query. Authoring ranges retain identity when source and intersecting pages
remain unchanged. Viewport anchoring captures a visible baseline point before commit,
prefers the same fragment/cell occurrence afterward, and restores its offset only if the
stage stays connected and the user has not scrolled.

## Idle prewarming

After a complete current snapshot without an authoring preview, the viewer schedules known
saved Apply/remove alternatives, starting with the open playbook item's choices.
Private composition/preparation cursors use the workspace artifact store, normal redline
rules and fingerprints, so warmed choices can retain foreground prepared identities. Each choice varies
one item against the current selection; conflicts are skipped. Unchanged resolved content and tokens are reused. Each alternative follows incremental
pagination from the current document's checkpoints, preparing geometry for changed blocks
and for unchanged paragraphs that newly require splitting or heading lookahead.
A full optional geometry cache stops new shapes from ordinary alternatives. The focused
item's choices may evict older optional shapes while current geometry remains protected.
Content preparation remains optional. Warming never publishes pages or snapshots. Foreground callbacks precede active
document alternatives, which precede unrelated document work. Active alternatives do not
wait for unrelated documents to finish warming.

Callbacks use a cooperative 4 ms budget, with yields inside tokenization,
redline alignment, container composition and preparation batches. Cached geometry can
advance within the same slice; newly measured shapes yield to the scheduler. A synchronous
DOM transaction or another indivisible operation can exceed the budget. These overruns
are measured explicitly; 4 ms is not a maximum callback-duration guarantee. Browsers
without idle callbacks use delayed timer slices. Input, source, preview, readiness,
epoch and teardown changes dispose the job. Foreground profile requests invalidate queued
and in-flight warm results before cache insertion; an already-running surface call finishes
before foreground work uses that surface. Correctness never depends on warming. Free-form
authoring possibilities and combinations of page assignments are not predicted.

## Local performance instrumentation

Development builds, or production with `PUBLIC_CONTRACT_PERF=1`, retain at most 100 entries
in each browser array. Instrumentation sends no analytics and stores no contract text.
`window.__contractColdStart` records source request, availability and acceptance milestones;
server/navigation latency requires a browser trace. `window.__contractRenderPerf` records
foreground requests only. Idle work receives no render metrics and does not alter samples.
Phase durations and partial composition/preparation counters are recorded on failure too;
completion timestamps are only recorded when a phase succeeds.

| Fields                                                                   | Meaning                                                                                                                                         |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `generation`, `sourceRevision`, `layoutEpoch`                            | Request and geometry environment identity                                                                                                       |
| `requestedAt`, `inputAt`, `renderStartedAt`                              | Browser-time-origin timestamps; capture records admin input and workspace clicks before handlers. Without a recent input, request time is used. |
| `composeMs`, `prepareMs`                                                 | Separate composition and preparation durations                                                                                                  |
| `affectedContainers`, `blocksRecomposed`                                 | Dirty containers and resolved blocks rebuilt by composition                                                                                     |
| `blocksProcessed`, `tokensProcessed`                                     | Blocks newly prepared and tokens newly tokenized; cache hits are excluded                                                                       |
| `compositionCompleteAt`, `preparationCompleteAt`, `paginationCompleteAt` | Completed phase timestamps                                                                                                                      |
| `profileResolveMs`                                                       | Active request-local geometry resolution time, excluding scheduler wait                                                                         |
| `profileCacheHits`, `profileCacheMisses`                                 | Requested geometry satisfied by cached/request-local geometry or requiring measurement                                                          |
| `profileUniqueMisses`, `profileBatchCount`                               | Missing shapes/upgrades and attempted synchronous surface transactions                                                                          |
| `profileDomUpdateMs`                                                     | Batched surface DOM updates, canonical table update and hidden-content cleanup                                                                  |
| `profileReadMs`, `maxProfileBlockMs`                                     | Total geometry-read time and largest block's read time; both table passes contribute                                                            |
| `profileTotalMs`                                                         | Synchronous transaction duration including DOM work, visitor, validation and cleanup; excludes scheduler wait                                   |
| `paginateMs`, `reconcileMs`                                              | Pure incremental pagination and content-safe reconciliation durations                                                                           |
| `firstPageAt`                                                            | First frozen page publication; viewer first exact display is recorded separately in cold-start milestones                                       |
| `preparationSlices`, `maxPreparationSliceMs`                             | Pagination/reconciliation slice count and maximum callback duration, excluding pacing waits                                                     |
| `pageCount`, `pagesChanged`, `pagesReused`                               | Final pages, changed page positions (including removed positions), and retained page objects                                                    |
| `snapshotAt`, `totalMs`                                                  | Snapshot assignment timestamp and request-to-assignment duration; cancelled/failed requests record time to termination                          |
| `commitToDomMs`, `settledTotalMs`                                        | Assignment-to-Svelte-tick and request-to-tick durations                                                                                         |
| `paintOpportunityAt`, `inputToPaintOpportunityMs`                        | Post-tick animation frame followed by a timer; a paint opportunity, not proof of physical presentation                                          |
| `cancelled`, `failed`                                                    | Request termination flags                                                                                                                       |

`window.__contractPageMountPerf` separately records generation, timestamp, page count,
append/atomic status and assignment-to-DOM-tick duration. It excludes pacing waits and retains
no DOM or text references.

Additional numeric diagnostics include `schedulerWaitMs` / `maxSchedulerWaitMs`,
`containerArtifactsReused`, `resolvedArtifactsReused`, `preparedArtifactsReused`,
`paginationRestartPage` / `paginationStopPage` (zero stop means no suffix shortcut),
`maxCompositionSliceMs`, `maxTokenPreparationSliceMs`, `maxProfileTransactionMs`,
and `profileTransactionOverruns` (transactions longer than 4 ms).
`visibleUpdateMs` records request-to-post-tick paint opportunity, alongside the existing
input-to-paint-opportunity field. Neither establishes physical presentation time.
Snapshot assignment is timestamped after artifact retention, so that bookkeeping remains
in request-to-assignment time. Optional phase and queue clocks run only when diagnostics
are enabled; cooperative budget and pacing clocks remain active.

Samples are copied at first-page publication, commit, after the DOM tick and after the paint opportunity. Partial
work remains measurable on cancellation or failure. Replacing the displayed snapshot or
destroying the controller cancels its pending paint observation. Geometry-read timings can
include browser layout; the first reader can pay for layout shared by the entire batch.
Development clocks add overhead, so use production browser traces for latency claims.

A prewarmed saved choice should show zero cache misses and zero profile batches. A normal
one-block change with uncached geometry should show one unique miss and one batch. Both
perform incremental pagination, reconciliation and one atomic snapshot commit. These warm operations retain immediate scheduling; initial pagination and mounting are paced.

## Verification and limits

Run `npm run verify` for the existing lifecycle and performance suites, type checks
and production build. See [performance checks](performance-checks.md) for their
automated guarantees and limits.

`npm run seed:verify` checks frozen output hashes, token/fragment conservation and
server-rendered source attributes. Semantic hashes cover original Trigger ownership;
full provenance hashes also cover secondary effects and their applied state.
Review output differences before updating expectations. Do not rewrite frozen
references merely to obtain a passing result.

Seed verification uses synthetic geometry and cannot establish browser pagination.
Browser click-to-paint, native selection, scroll stability, font epochs and highlight
geometry require browser verification. Use production traces for latency claims.

## Startup diagnostics

`window.__contractStartupPerf` retains source acceptance timing plus count-only
workspace/renderer/authoring acceptance/profile-surface events. The pure domain's
fixed numeric counters are available under `window.__contractDomainPerf`: record
comparison/recompilation/reuse, projection reuse, geometry entry mutations, queries,
and visited candidates. Take counter differences around a transition. No document
text or backend identifiers are included.

These diagnostics use the existing development / `PUBLIC_CONTRACT_PERF=1` gate.
`__contractColdStart` and `__contractRenderPerf` still separate source acceptance,
viewer/profile mounts, layout epochs, render phases, interaction readiness, and
paint opportunity. They are not a substitute for controlled production traces.

The existing seed verifier still checks all 48 frozen effective/redline states, exact source
and generated provenance, and token/fragment conservation. It maps only trigger annotation
IDs to their former encoding when comparing frozen provenance hashes; the hashes are unchanged.
Server markup checks source/generated spans and preserved projection memberships. Projected
native hit targets, accessibility, geometry, focus and annotation-independent layout require
the browser acceptance described in `docs/lifecycle.md`; existing suites do not certify them.
