# Document domain and incremental ingestion

## Implemented boundary

The app layout owns a pure `DocumentDomain` alongside the existing, independent
`ContractLayoutProfiles`. The domain retains one `CompiledContract`, accepted
Playbook records, rendering projections, a `PlaybookGeometryIndex`, and numeric
work counters. It has no renderer, DOM nodes, Svelte effects, transport, draft,
selection, or search state. Each route still creates its own workspace, source
publication, composer, renderer, snapshot, and viewer. Admin still owns its draft
and explicit Save transaction.

The supplied plan described an older autosave lifecycle and a layout-owned
AuthoringSession. The supplied repository has explicit Save and a route-owned
session. This implementation preserves the repository's newer product behavior:
no save timer, dismissal save, or visibility save was introduced.

`CompiledContract` wraps the existing baseline validator and SourceIndex. The
baseline is compared exactly before compilation and copied at acceptance; there
is no backend baseline version. Authoring and source picking receive that same
compiled source. The compositor receives its canonical index through the existing
render source and continues to own activation, numbering, reference dependencies,
and exact dirty-container closure.

## Record identity and incremental updates

The authoritative writer audit covered `src/convex/admin.ts`, all other Convex
modules, and `scripts/seed-convex.mjs`:

- Creation writes revision 1 and a creation operation ID/receipt.
- Update replaces the full record at expected revision + 1 and changes the
  operation ID. Idempotent replay does not change the record.
- Delete removes the record after the existing revision check.
- Seed imports only initial company content, refuse edited/unexpected committed
  prefixes, and use the shared authoring writer to create revision 1 and its
  immutable head. They do not fabricate author IDs or operation receipts.
  There are no other Playbook writers in this tree.

Every accepted record has a required revision. Identity uses creation time and
revision within its stable item ID. All writers that change content must advance
that revision; operation metadata is not required for seed-created records.
There is no serialized-record fallback for unversioned data.

Only changed records are copied, projected through `toDocumentOverlay()`, and
compared with their previous rendering projection. Unchanged projections retain
object identity. Subscription order is compared independently. Removing one item
removes only its entries; duplicate item IDs reject acceptance without partially
publishing a snapshot. Query failures retain accepted data.

Changed IDs drive index updates directly; render revision and geometry version
are the publication signals consumed by the runtime. Unused delta serialization
and affected-container walks have been removed. Wording changes refresh indexed
change objects without moving interval entries; only
ranges, Trigger identity, concession/change structure, or empty-content activation
change geometry version. Metadata-only changes preserve render source identity.
The route publishes one render source for the accepted domain revision, never an
intermediate baseline-only render.

## Geometry and authoring

Per-container maps of entry sets retain owner item, concession position, change
position, and Trigger IDs. Positional refresh remains correct even when an imported
item has duplicate concession IDs; the full content audit still rejects those IDs. Container discovery uses a binary search over
ordered source bounds and includes insertion endpoints. A cross-container Trigger
is registered in every covered container. Interactive queries visit only candidate
containers; all exact intersection, ownership, optional-slot, and conflict decisions
remain in `ranges.ts`, `geometry.ts`, and `conflicts.ts`.

Snapshot ingestion refreshes cached geometry diagnostics once per affected item,
including duplicate Trigger IDs, overlaps, ownership, and intra-concession conflicts.
Old/new Trigger containers and global ID buckets invalidate related items. Initial
source picking checks those diagnostics, then validates a candidate Trigger against
indexed neighbors and only changes intersecting its range. Secondary/concession selection overlays current draft
Triggers while excluding its persisted item. Existing source/primary-change/Trigger
issue precedence is retained. Existing invalid source entries retain diagnostics;
replacing the item excludes its own failed entries and rechecks failing neighbors
without the saved item, so a corrective draft is not blocked by stale relations.

Authoring owns lifecycle and field readiness. Its domain-provided memo retains only
one draft's geometry key and diagnostic, not a copied persisted Trigger universe.
Instructions/description/tier changes and replacement wording edits that preserve
empty/content status do not query cross-item geometry. Ingestion and draft validation
share `playbookGeometryKey`; ranges, Trigger IDs, change grouping, and empty-slot
activation invalidate it. Geometry version changes also invalidate that memo.
Content and reference validation still runs independently of the geometry memo. Pending creation retains the existing isolated
validation behavior while its exact immutable operation awaits acknowledgement;
server validation still determines persistence authority.

The complete audit constructs the same index and uses the same primitive geometry
validators. Convex structural saves still read and atomically validate the full
proposed live set through `validatePlaybook`. The source-independent save path,
creation receipts, revisions, delete rules, and replay behavior are unchanged.
The full audit lives in `playbook/audit.ts`, independently of the primitive
validators, and validates each item's geometry once. It no longer revalidates all
neighboring changes for every item. Interactive queries reject unrelated malformed
persisted geometry using the cached diagnostics, without repeating the full audit.

The editor treats unresolvable saved ranges and reference labels as unavailable
display context. It keeps removal controls usable while session validation prevents
saving invalid content. The unused `rangeContext` helper has been deleted.

## Interaction discovery

Search text now comes from committed paginated tokens. It preserves per-character
Unicode character folding (shared with query normalization, including Greek final
sigma), whitespace collapse, UTF-16 offsets, non-overlapping match
order, flowing paragraphs across pages, and separate table-cell occurrences
(including repeated headers). Results contain page, fragment, cell, token, and
character positions. DOM queries resolve only matched token locations into ranges.
Unchanged token/location groups retain their normalized corpus and cached matches.
A route-local range cache preserves native Range identity when both resolved nodes
and offsets still match. Changed or unmounted nodes, root replacement, and search
clear invalidate the corresponding cached ranges. A commit refreshes model locations
and mounted ranges without scrolling. The unused whole-document DOM text index is gone.

Annotation segments register their semantic membership IDs with a viewer-local
mounted-owner registry. Focus/panel lookup reads only the requested membership's
owners and preserves the existing source/generated-character/page preference
ranking. Destruction removes registrations. Hidden profile segments register no
memberships. Source/provenance DOM attributes and native selection remain intact.

No page virtualization was introduced. Search targets do not require mounted nodes;
a future virtualized viewer must mount the target page before resolving its range.
Annotation membership discovery is registered rather than a stage scan, but mounting
an absent occurrence and native-selection pinning remain future virtualization work.

## Verification and limits

Dependency installation could not complete: npm registry access was unavailable,
an elevated install was not executed because automatic approval review hit a usage
limit, and an offline install reported `ENOTCACHED`. The unmodified baseline and
final npm checks therefore cannot run without the project's dependencies. This is
not a successful Svelte/type/build/format certification.

Available local verification used Node's TypeScript transform and the existing
frozen parity verifier, with its unavailable Svelte rendering section explicitly
excluded. The original verifier and frozen references were not modified:

- Complete seed domain validation passed: 113 blocks, 56 items.
- All 48 effective/redline semantic and full provenance hashes passed.
- Existing token/source and synthetic pagination fragment-conservation checks passed.
- Old-scan versus indexed selection review matched 1,936 initial selections and
  3,872 secondary/addition selections across seed source ranges, empty anchors,
  reference atoms, and table cells. Ten valid/duplicate-Trigger full-audit variants
  agreed on acceptance. These are local review comparisons, not a new test suite.
- Server-rendered source-span checks were **not run**.
- Changed TypeScript and Svelte script sections parse; this is not a type check or
  a Svelte template compilation.
- The profiler/cache, preparation, pagination, renderer, and profiling surface are
  byte-identical to the supplied archive. This protects the implementation boundary
  but does not substitute for browser route/cache/epoch regression checks.

The review-fix checks additionally confirmed:

- Dense full-audit candidate visits are 1,250 / 5,000 / 20,000 for 25 / 50 / 100
  single-Trigger, single-change items in one container, replacing cubic repeated
  neighbor validation. These counts include the initial geometry validation.
- Malformed duplicate-ID, overlap, ownership-boundary, intra-concession conflict,
  and coordinate cases reject unrelated selections and allow corrective drafts or
  deletion. Duplicate Trigger IDs across separate containers also clear correctly.
- Metadata refresh preserves both indexed changes in a duplicate-concession-ID
  record without geometry work; the full audit still rejects its duplicate IDs.
- Initial selection eligibility matches the original scan on 3,908 seed ranges.
- A DOM protocol double confirms Range reuse on unchanged results and invalidation
  on partial updates, remount/unmount, root replacement, reset, and clear. This does
  not replace a browser highlight-layout check.

`docs/domain-runtime/` retains command results and work-counter observations.
A revision-bearing copy of the supplied seed produced these work counts:

| Transition                                 | Records projected | Entries inserted/removed | Render revision advance |
| ------------------------------------------ | ----------------: | -----------------------: | ----------------------: |
| Equal complete result                      |                 0 |                    0 / 0 |                       0 |
| One instructions-only update               |                 1 |                    0 / 0 |                       0 |
| Draft instructions typing after validation |                 0 |                    0 / 0 |                       0 |
| Reorder only                               |                 0 |                    0 / 0 |                       1 |
| Delete one single-Trigger item             |                 0 |                    0 / 1 |                       1 |

These are work counts, not browser latency benchmarks. Current seed imports use
the same revision identity as admin-created records.

`PUBLIC_CONTRACT_PERF=1` (or development mode) exposes fixed numeric counters at
`window.__contractDomainPerf`, with `ingestion` and `geometry` groups. Existing
render/cache metrics and source-accept timing remain available. Counter deltas
show recompilation, projection, entry mutation, query, and candidate work; they
contain no document text or backend IDs.

Before deployment, run `npm ci`, `npm run check`, `npm run format:check`,
`npm run build`, and the unmodified `npm run seed:verify`. Then run the supplied
plan's browser acceptance matrix: explicit Save/retry/conflict/delete, selection
boundaries, search and annotation focus after repagination, route state isolation,
shared/fallback profiling, and font/resize epoch invalidation.

## Decisions requiring production evidence

No controlled authenticated production build/browser was available. Accordingly:

- Phase 7 (stable prepared/page identity) is deferred, with existing identity and
  compositor version maps preserved.
- Phase 10 (virtualization) is deferred pending visible DOM/paint traces and
  target-page mounting/native-selection prerequisites.
- Phase 12 (transactional Convex geometry tables) is deferred pending representative
  structural-save read/latency measurements.

There are no invented latency targets or claims that these costs are insignificant.
The normal route-profile default, `PUBLIC_CONTRACT_ROUTE_PROFILES=0` fallback,
profile metadata opt-in, geometry fingerprint, live epoch, bounded LRU, and
foreground/idle serialization are unchanged. Production/browser acceptance remains
open even though the source implementation and available semantic checks are done.
