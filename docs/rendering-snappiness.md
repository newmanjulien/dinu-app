# Contract geometry compilation and pure pagination

The renderer composes provenance-preserving blocks, prepares stable tokens, resolves
browser geometry, and runs one resumable paginator with internal page-boundary checkpoints. Initial openings
admit three exact closed pages together, or the entire shorter document as soon as pagination
finishes and its pages flush, before full custom metadata is required; the complete
`RenderSnapshot` adopts those frozen page objects. Warm updates retain the displayed
complete document until their complete replacement commits. A cache-only render never
touches the profiling DOM. See [verification and limits](#verification-and-limits) for automated checks and
remaining browser acceptance limits.

## Composition and preparation

The workspace source controller owns a template source-scoped artifact store shared with rendering and concession warming.
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
template source or destroying the workspace source releases the store; layout epochs and content
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
`/template` and `/template/buyers` each subscribe to `currentStructure` for their audience and keep a bounded live item-detail pool.
It starts warming as soon as the template source matches ready structure, independently of renderer
readiness: all fitting items, with 64 optional entries, eight first responses in flight
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
same-template source read restarts; retired callbacks cannot change current demand.
Only selected/save-confirmation records enter the stable hydrated-detail projection. Optional
arrivals do not notify foreground authoring reconciliation, change document render identity or
paginate. Optional errors remain local to warming; accepted successful current reads retire
only their own failed-read suppression. Deactivation, pause, blocking, freezing, suspension and
template source mismatch release optional work and nearby reporting; any released/recreated read
requires a fresh observation.
Successful structure acceptance memoizes the exact immutable
array, pending render key, compiled contract identity and certification mode; detail hydration
continues independently. Failed acceptance invalidates that shortcut. Certified structural
snapshots build interval buckets in one
pass, avoiding repeated audits of unchanged neighbors. Source blocks and their fingerprint
arrive atomically; authoring readiness requires matching current structure. Detail readiness
also requires an authoritative successful watermark and matching revision. An unavailable
detail is loading/error, not proof that its rule was deleted. Warm selections reuse their
existing current live snapshot synchronously; cold selections wait in the anchored rail/sheet
without adding a loading row or changing document height. Editing copy can continue while
a wording preview lays out; new source selection requires the coherent displayed snapshot.

Only active replacement effects contribute to `DocumentRenderSource`. Annotation-only
updates retain that source, prepared tokens, pages and `selectionDocument`; they schedule no
composition, token preparation, paragraph profiling or pagination. Actual wording changes
reuse the template source artifact store and compatible pagination history. Template alternative warming
requires an open panel, so confirming an instruction does not start optional layout work.

`DocumentAnnotationProjection` indexes mounted token provenance once per complete snapshot
and projects changed annotation ranges over the shared highlight controller's measured line
maps. It handles template source source, removed runs, generated replacement intervals, repeated
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
not invalidate text layout; content commits and layout epochs retain geometry invalidation.

## Browser geometry compilation

The app layout mounts a persistent `LayoutProfileSurface` and provides its `LayoutProfiler`
to route viewers. A standalone viewer, or `PUBLIC_DOCUMENT_ROUTE_PROFILES=0`, uses the
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
`data-document-token` marker. Hidden leaves omit unused source-coordinate and interaction
attributes by default; `PUBLIC_DOCUMENT_PROFILE_METADATA=1` restores them. Visible leaves
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

The surface publishes readiness synchronously on mount. Documents explicitly use local
Arial/Helvetica/sans-serif, so unrelated UI and Newsreader loading does not gate pagination
or highlights. Epochs distinguish surface mounts and layout policy; unmount invalidates
retained handles. The profiler checks the live epoch before and after profiling and
rejects stale results before cache insertion. A new epoch prevents old page reuse.
Highlights invalidate on actual content commits, changed pages, layout epochs and observed
geometry changes. The support widget retains its own specific Newsreader wait.

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

`DocumentRenderController` serializes requests and checks generation and live epoch after
profiling and immediately before committing, including after commit listeners. The same
currentness check runs when queued profiling starts and before inserting its results, so
cancelled or superseded requests skip pending DOM work. A pending job records request
identity, source, selections, preview, epoch, finished pages and running/failed status.
Partial pages never become a `RenderSnapshot`. A published complete snapshot contains accepted source, concessions, preview changes, pages, epoch and changed
page numbers. Page records, placement records and their arrays are frozen at publication;
prepared content follows the immutable input contract.

Initial openings include reactivating retained pages that disagree with confirmed intent.
They admit the three-page or completed-short exact batch, then append one actual available
page per paced slice and show “Preparing remaining pages…” at the tail. Document height
comes from mounted pages; completion does not bulk-mount a backlog. Fully mounted matching
retained contracts display immediately. Every append validates generation, source identity,
selections, preview, epoch and preparation eligibility. Invalidation, cancellation and eviction
clear partial work; partial pages count toward inactive retention budgets.

Before initial-batch display, pagination retains four-millisecond preparation slices and
continues past the first closed page. A flushed displayable batch acknowledges only its
matching generation/layout epoch after a visible opportunity, outside serialized work.
Visible preparation and individual page appends share an eight-millisecond deadline starting
in a task after a frame. Queued appends take precedence within paced work, and their awaited
DOM flushes count toward the same window. More work can run while time remains; an indivisible
measurement or mount can overrun. Explicit warm updates dispatch immediately and remain
atomic; speculative preparation uses idle dispatch.

Scrolling and native selection work during partial display. Initial pages mount one per
scheduled append task behind a quiet loading frame; they become visible together once the
three-page or completed-short batch is flushed. Remaining real pages append below without
replacing the admitted prefix. There are no invented future paper placeholders. Current,
prepared and matching retained pages bypass buffering. Hidden initial DOM in a visible tab
can prepare the batch without waiting for a first-page paint acknowledgement; parked work
needs no physical paint acknowledgement. Hidden-tab background suspension, foreground
priority, cancellation and host/profiler readiness still govern dispatch.

Custom highlight discovery, gestures, clause activation, concessions, authoring and full-document
search require the complete snapshot and mounted DOM. Native early reading requires neither
custom metadata nor a partial-page interaction controller. The complete snapshot adopts the
published page objects, and metadata/controllers initialize once on complete readiness.
Before-threshold failure shows local retry; after-threshold failure preserves actual pages
with a tail retry. Empty pagination is an explicit failure. Source/generation/layout fences
prevent obsolete append or paint acknowledgements from releasing a replacement opening.

Creation closes its name/deal dialog on confirmed saved-route admission after frozen seeding
and owner/navigation handoff, independently of host or pages. `exactDisplay` and the creation
`displayed` timing report the later threshold DOM milestone; neither certifies physical
paint. Full readiness remains a separate milestone. Saved module, data, host and renderer
retries retain the same route opening, editor and resource lease without another create.

Page-number keys preserve unchanged DOM. Highlights refresh changed page geometry and retain
unchanged range contributions; hover and pressed-state updates affect paint separately.
Search updates changed source blocks, retains unchanged ranges and performs no traversal
for an empty query. Authoring ranges retain identity when source and intersecting pages
remain unchanged. Without an open panel, viewport anchoring captures a visible template source
point before commit, prefers the same fragment occurrence afterward, and restores its offset
only if the same stage, source and committed pages remain current and the user has not scrolled.
Opening a panel cancels queued compensation and gives its held workspace position priority.
The active panel's viewer subtree excludes native scroll anchoring. Preview commits neither
remeasure an already-resolved same-target panel nor scroll to its source; deliberate navigation
and returning from secondary-location picking retain their explicit scrolling behavior.

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

Development builds, or production with `PUBLIC_DOCUMENT_PERF=1`, retain at most 100 entries
in each browser array. Instrumentation sends no analytics and stores no contract text.
`window.__documentColdStart` records source request, availability and acceptance milestones;
server/navigation latency requires a browser trace. `window.__documentRenderPerf` records
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

`window.__documentPageMountPerf` separately records generation, timestamp, page count,
append/atomic status and assignment-to-DOM-tick duration. It excludes pacing waits and retains
no DOM or text references.

### Highlight and automatic Help opening trace

`window.__documentLoadingPerf` is a bounded, identifier-free timeline for the loading gap. It is
available in development and with `PUBLIC_DOCUMENT_PERF=1` in production. Each entry has a
browser `performance.now()` timestamp, a route class (`saved`, `template`, `buyer`, or `other`),
and a milestone name. Viewer entries also include a local viewer number and render generation;
the first visible highlight entry includes the number of attachment rectangles on the first
three pages. Complete-page entries identify whether that viewer was active. No
contract identifier, content, or annotation identifier is retained.

For a cold opening, compare `first-pages-dom-ready` with `complete-pages-dom-ready`,
`annotation-projection-ready`, `first-highlights-dom-ready`, and
`highlight-actions-enabled` for the same viewer and generation. The first mark follows the initial
page DOM flush. The first three exact mounted pages can now project and paint their annotations
while later pages paginate; that early projection stays fixed until the complete snapshot takes
over the same highlight controller. The complete-pages mark follows the final page DOM flush.
The highlight mark follows a Svelte flush containing at least one attachment rectangle on the
first three pages. The actions mark requires an enabled projected annotation control there and
still waits for the complete snapshot. A document with no
attachment highlights legitimately has neither of the last two marks; a document with
non-actionable highlights can have the highlight mark without the actions mark. Geometry work
can still delay the highlight mark after the first pages. These marks do not claim a physical
paint or a successful click, and no browser latency improvement has been measured.

For proactive Help, compare entries with the same numeric `opening` value:
`help-opening-start`, `help-policy-resolved`,
`help-automatic-open`, `help-modal-open`, and `help-document-admitted`. The modal-open mark
comes from the actual dialog `showModal()` path. Admission is the point at which the route
allows document construction after giving the modal a paint opportunity. A hidden preference
has no automatic-open mark. Template Help is manual and has no automatic-open mark. The buyer
trace starts before link access resolves; the saved trace starts when its route opening is
owned. These are separate from rendering and can settle in either order.

Use the entries for one opening together with `__documentRenderPerf`,
`__documentPageMountPerf`, and a browser Performance trace when checking actual latency.
The instrumentation records state and DOM flushes only. It intentionally adds no reveal
timer and does not delay ready content. Physical paint, perceived smoothness, and native
click behavior still need a browser check.

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

Clause-panel openings retain canonical live DOM lookup and the existing post-tick
placement guards. Redline renderers cooperatively prepare the baseline source index and
ordered original footprints after pagination; compatible source artifacts reuse those
facts across snapshots and layout changes. Only complete facts are attached to a matching
snapshot. Cancellation drops partial work, and optional preparation failure leaves the
synchronous canonical fallback available. Effective view skips these baseline facts.
Occurrence scans, target-dependent sorting and live geometry remain per opening.

`window.__documentPanelOpenPerf` contains numeric-only activation samples (at most 100):
`at`, `admissionMs` / `accepted` / `admittedAt`, `positionRequestedAt` / `domReadyAt`,
`lookupMs`, `geometryMs`, `preparedSourceFacts`, `effective`, `heldPosition`, `resolvedAt`
and `contentMountedAt`. The last field records a post-update mounted panel subtree,
not loaded editor data or physical paint. Rejected, cancelled or unresolved openings
have incomplete milestones; held-position reuse has no lookup duration. No extra tick
or animation frame is requested for these samples. `window.__documentPanelReadiness`
records numeric `at` / `ready` admission-policy transitions, including readiness after
preparation. Compare those and render `totalMs`, rather than lookup time alone, when
assessing work moved before opening. Render samples include `panelSourcePrepareMs`,
`panelSourcePreparationSlices`, `maxPanelSourcePreparationSliceMs`,
`panelSourceFactsReused`, `panelSourcePreparationFailed` and `panelSourceReadyAt`.
Slice budgets remain cooperative; an indivisible generator step can overrun.

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
Browser click-to-paint, native selection, scroll stability, mount/style epochs and highlight
geometry require browser verification. Use production traces for latency claims.

## Startup diagnostics

`window.__contractStartupPerf` retains source acceptance timing plus count-only
workspace/renderer/authoring acceptance/profile-surface events. The pure domain's
fixed numeric counters are available under `window.__documentDomainPerf`: record
comparison/recompilation/reuse, projection reuse, geometry entry mutations, queries,
and visited candidates. Take counter differences around a transition. No document
text or backend identifiers are included.

These diagnostics use the existing development / `PUBLIC_DOCUMENT_PERF=1` gate.
`__documentColdStart` and `__documentRenderPerf` still separate source acceptance,
viewer/profile mounts, layout epochs, render phases, interaction readiness, and
paint opportunity. They are not a substitute for controlled production traces.

The existing seed verifier still checks all 48 frozen effective/redline states, exact source
and generated provenance, and token/fragment conservation. It maps only trigger annotation
IDs to their former encoding when comparing frozen provenance hashes; the hashes are unchanged.
Server markup checks source/generated spans and preserved projection memberships. Projected
native hit targets, accessibility, geometry, focus and annotation-independent layout require
the browser acceptance described in `docs/lifecycle.md`; existing suites do not certify them.

## Loading and dependency admission

Skeleton visibility does not make a primary presentation ready. Optional CSM and Home/deal warming still wait for the current primary ticket and its paint/idle policy; advisory setup hints follow that policy too. The heavy profiler is installed by the demanded document host, and the authoring controller implementation by TemplateWorkspace; lightweight membership persistence owners remain stable. Read retries do not key accepted viewers. `npm run verify` includes SSR/exact-fixture hydration and emitted loading-module boundary checks; actual layout/paint/native behavior remains manual browser acceptance.

Saved source admission shares one editor-root definition-readiness calculation. Required
local wording must be complete before preparation; a cold read failure uses the existing
viewer Retry and the saved opening's reset. Final view detachment replaces the editor's
materialized template-item, combined-item and atomic-input caches with empty values even
when pending or failed saving retains the editor. This does not evict caller-owned data
or the document resource cache, and no heap or latency improvement has been measured.

## Template prose and canonical saved creation

The membership's `TemplateSource` retains accepted blocks and their fingerprint after the
last live lease releases. Both audience editors and New contract share that prerequisite
owner; prose is membership-authorized, while compact structures and authoring remain
admin-only. Creation shows the real template wording behind the naming dialog and starts
that preview while the user types. Submission freezes the displayed prose until the saved
contract's first pages are ready. The preview has no highlights or creation skeleton, and
it is not adopted as saved authority. Confirmed creation acquires the existing saved editor
and keyed resource opening lease immediately, then loads exact frozen metadata. Saved wording
and its single canonical preparation require that editor's validated approved payload;
metadata or a newer live template never supplies authority. The lease protects existing or
future resources through lazy module/host/data/render retry and transfers into the actual
saved attachment without a protection gap. Disabling shared preparation retains one local
canonical viewer after authority and host readiness. Operation IDs and uncertain retries
remain frozen; post-admission failures never create a second contract.

## Help and tool admission

ContractRoute owns one HelpSession, policy decision and modal host per true destination/account
opening above saved code, host, readable data, pagination and search. A→B→A creates three
decisions; transport/module/render retries create none. Preference resolves before saved
presentation admission, so enabled automatic help is the first complete working modal over
the quiet loading frame. Creation's naming dialog tears down first. Module or document
completion preserves the same modal/focus and dismissal. Preference writes are fenced by
account, transport generation and opening ownership. Templates keep manual help; buyer
preference/preview policy retains its existing owner and admission.

Search code/controller/panel loads separately from lightweight Help. Tool resources and the
shared HubSpot status observation prepare independently. Each rail shows an ordered
applicable prefix: Search, Download when Quotes policy requires it, Settings when applicable,
Help. Unknown applicability blocks lower controls; absence skips its slot. Ready controls
may display disabled while execution waits for full readiness. Search module failure or
the actual shared integration timeout/error resolves to a local retry control, allowing
lower controls to display. Retry uses that same shared owner. Consecutive ready slots appear
in one update, with no stagger timer or extra status query.

`DocumentSourceController.renderReady` means a coherent render source has been accepted.
It is independent of `itemsCurrent`. Both retained and resource-off viewers can prepare
prose while the compact structure is outstanding. Prose acceptance checkpoints the domain,
accepts blocks, and runs `DocumentDomain.clearProjection` before publication. That single
operation replaces structures, structure-input/index, records/index, annotation/content
projections and geometry with empty values for the accepted compiled source; the controller
also clears the old selection. Failure rolls back to the prior coherent display. The same
clearing applies to a complete structure's changed source ID or fingerprint, even when its
prose fingerprint permits reusing the compiled blocks.

A matching complete structure adds certified geometry and annotations to those same blocks.
With an empty concession selection, the render-source object and its artifact store stay the
same: structure arrival alone requests no composition, profiling or pagination. Current
matching structure and source remain prerequisites for authoring and normal workspace
presentation admission. First useful prose presentation admits only deferred cache work;
it does not certify editing or start speculative body warming. Old-source panel targets,
highlights and wording previews are withheld. Dirty intent stays in its original controller;
a retained old-source draft cannot submit or bind to the replacement source.

Released detail listeners keep bounded accepted bodies but lose successful-observation
status. A selected exact-source/exact-head retained or disk body can fill a read-only panel
immediately. The same `PlaybookCard` and semantic selection remain while a fresh current
response enables the editor. Cached text never initializes the editable controller, recovery,
or save acknowledgement. A genuinely cold selection shows its known heading, selected/busy
state and Close action in that rail, without placeholder paragraphs. Newer heads, missing
membership, source-ID changes and explicit rejections withhold stale bodies. Existing 64-ID,
4 MiB optional memory and eight-first-response limits, pin priorities and foreground bypass
still apply; ordinary release/freeze/detach stops optional subscriptions.
