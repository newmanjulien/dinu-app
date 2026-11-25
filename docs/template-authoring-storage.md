# Template authoring storage and cutover

`/template` reads compact structure independently of source prose and item
bodies. This document describes the implemented storage boundary. It does not
record a deployment or a completed live-data migration.

## Authorities and read surfaces

`playbookItemRevisions.body` is the sole business-content authority. A normalized
`playbookItems` head stores company/revision/replay identity, a stable `renderKey`,
and a private binary structure projection. It contains no instruction or explanation prose or
replacement wording. Existing head IDs/timestamps remain unchanged. New render keys
use the creation operation UUID; converted records use their original item ID. Creation
receipts reserve each UUID within the company, including after deletion, so another membership
cannot publish a colliding annotation identity.

An admitted template destination starts its selected audience's compact reads alongside
editor code loading. The membership shares one `templateSources.authoringSource`
subscription across audience sessions; opening and mounted owners retain the same reads.
WorkspaceScope constructs, configures and destroys that source once. Audience sessions
receive it as a required dependency and own their separate compact structure subscriptions.
The admitted route and mounted editor keep independent read leases; their overlap uses
the existing reader count without another subscription or ownership-transfer callback.
Opening demand does not create drafts, select template items or preload their bodies.

`playbookItems.currentStructure` owns the template source ID/fingerprint, readiness,
complete ordered membership, compact geometry, and authoring/structural generations.
`playbookItems.content` reads one authorized head/revision and the source/certificate;
it does not read the global pointer, version manifest or generations. The client admits
its body only when source ID/fingerprint, item ID, company, creation time, content
revision and render key exactly match current ready structure. An item's missing content
result never establishes deletion; only complete ready structure establishes absence.
The authoring session uses `content`; complete membership and generations remain
owned by `currentStructure`.

Save/delete acknowledgement first requires structure at or beyond the mutation watermark,
then exact operation/revision evidence or a later revision. Conflict and missing responses
carry transactional watermarks for recovery. The session retains these witnesses separately
from the immutable retry request; recovery requires sufficiently new structure and matching
content, with a conflict revision floor. A missing mutation requires complete same-source
absence before restoring as a new template item. A different source requires a strictly newer global
authoring generation than the witness or submission. Source loading/errors remain client
states. `templateSources.authoringSource` returns blocks and their fingerprint atomically.

The active template authoring session eagerly warms a bounded pool of live item-content subscriptions
as soon as the loaded template source matches ready structure, before renderer interaction or a first
selection. Documents that fit the pool warm every item. Optional retention is limited to
64 item IDs, eight subscriptions awaiting their first response, and 4 MiB of encoded retained
records. The byte budget excludes unknown first responses, pinned records and object/client
overhead; it is not a heap limit. Pending selection, actual editor and submitted-operation
targets are pinned independently. Completed editor-owner transitions immediately count demoted
records against the optional limits; a pending switch keeps the previous editor pinned.
Closing/switching retains useful live content, prioritizing the last eight admitted real
selections/opens (including successful existing-item restores), nearby pages in semantic source
order, then remaining structure order. Byte-pressure admission stops lower-priority warming
for that ranking instead of repeatedly refetching.

Nearby demand reuses the highlight controller's visible-plus-adjacent-page signal and semantic
annotation registry memberships, including boundary/bookmark anchors and grouped controls.
It rebuilds after owners commit or boundary controls return from location picking. Each eligible
reporting lifetime receives current-page demand again, including after a same-template source read
restart without scrolling; reports from a retired lifetime cannot change current priorities.
Only selected/save-confirmation rep bodies enter the document source; buyer explanations
remain in the authoring session and their highlights use compact structure. Background arrivals do not
change that projection or paginate. Optional errors stay outside foreground error/leave logic.
An accepted successful current read retires only that item's failed-read suppression, without
relaxing authority checks or optional budgets. Inactive, paused, blocked, frozen, suspended or
mismatched-template source workspaces release optional subscriptions and invalidate nearby reporting.
Release/retry/restart invalidates observations: a recreated listener must respond before its
body can satisfy authority, recovery or new acknowledgment checks. Global-generation and
exact head-revision checks remain mandatory even for retained bodies. A cold selection uses
the existing anchored editor rail/sheet while waiting, with no normal-flow loading row.

`templateSourceCertificates` contains one small indexed certificate per template source: fingerprint,
codec version, ordered fact-chunk IDs, counts and exact native bytes. Keeping this
separate preserves the native document envelope of template sources whose DOCX issue arrays
already approach 1 MiB. `templateSourceValidationChunks` holds bounded private binary data.
Facts contain source coordinates, block/container order and table barriers, numbering
sequence/parent/depth and a nine-bit numeric-token mask. They omit source/display text.

Full-source and compact validators consume `ValidationSourceFacts`. Bulk source
acceptance checks the complete template source, references and address ambiguity. Its atomic
business commit carries an audited format-0 pending certificate. An idempotent scheduled
source-only mutation encodes/decodes facts, compares every coordinate/key/reference fact,
and upgrades the version to format 1 before authoring becomes ready. Ordinary saves
verify the certificate/fingerprint/counts without reading or hashing template source prose.

## Ordinary transactions

Creation, updates and deletion share exact version-delta accounting. Each mutation
resolves authorization, replay and revision conflict first. Content validation reads
only the changed body. Changed structure additionally reads certified facts and
compact heads, builds trusted interval buckets without repeatedly auditing unchanged
neighbors, and validates the changed trigger/changes and effects on existing ownership.
Deletion relaxes ownership because unowned changes are valid. Retained concessions
remain immutable.

Head, revision, creation receipt, ordered manifest, counters and pointer commit in one
transaction. Each canonical writer packs its completed compact head once and reuses that
payload for storage and exact native capacity/accounting, including system fields where
required. Only the changed historical JSON body is serialized. Creation/deletion
also adjusts array punctuation. Native counters use actual old/new revision wrappers,
including replay metadata and mutable markers. Late marker assignment updates its
owning version's native total in the same transaction. Frozen business history and
whole-transaction rollback remain unchanged.

Both generations belong to the company timeline and carry across version IDs.
Authoring generation advances for every write; structural generation advances only
when trigger/concession geometry changes. Prose saves may recompute the global compact query; unrelated item-content queries
do not read this timeline. Source, access and certification changes still invalidate them.

## Physical layout and admission reasoning

The product bounds remain 4,096 template source blocks, 4,000 rules, 500,000 business JSON
bytes per rule and 8,000,000 historical JSON bytes. Native document, array, query,
transaction and result bounds remain independent.

The selected encodings and transaction boundaries avoid amplification:

- Source chunks and facts are written in separate bulk transactions. This preserves
  admission for source-heavy imports; duplicating their lossless keys in one native
  transaction could exceed the write budget. The atomic business bootstrap/activation
  remains unchanged, while authoring readiness waits for the format-1 certificate.
- Keys occur once per original source/target field. Generated `number:` source keys
  derive from the already encoded numbering item key. They are not another stored
  copy of a potentially large key.
- Strings frame scalar runs as UTF-8 and only unmatched surrogate runs as raw UTF-16.
  A lone surrogate therefore does not double a large ASCII key. Original UTF-16 length,
  frame lengths and varints bound decoding; UTF-8 decoding preserves literal BOMs.
- Structure encodes target/ID fields and counts, removing business-object property
  names, instruction/explanation/replacement wording and reference-display patterns. Paragraph
  breaks and meaningful-content state use one count/flag value. Facts derive ordinals,
  regions, boundaries and positions rather than repeating them per source unit.

For the current schema, these variable payloads are bounded by their corresponding
source/business JSON contributions: omitted field syntax/content pays for length
frames and varints, including mixed-surrogate frames. Compact head wrappers add only
bounded IDs/replay fields. Historical JSON already includes original item identity.
Fact payloads may cross chunk boundaries; a long key never needs a document of its own.
Fact chunks target 768 KiB and stay below the native 1 MiB cap. Rule revision wrappers
retain the native per-document check independently of the 500,000-byte business bound.

The native size implementation installed with Convex counts strings/bytes, object
field names, 9-byte numbers, nested values and system fields. The smallest numeric
pattern object (`{level:1}`) costs 17 native bytes versus 11 JSON bytes; the other
number-bearing model objects have more field syntax per counter. This provides a
conservative 17/11 multiplier for source/business native values, before separately
counting original identity, revision wrappers, manifests and parent metadata. Packed
facts/heads do not carry that numeric-object amplification. The 8 MB aggregate and
4,000-entry bound leave room for fixed wrappers and the read/result reserves; physical
native checks still use actual values rather than assuming JSON equals native bytes.

The implementation maintains these independent envelopes:

| Surface                   | Counted work                                                                                                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary structural save  | Exact compact-head total + fact-chunk total + certificate/version/template source metadata + 2,100,000 bytes for changed head/body and access work; document/read/query/write checks remain active. |
| Wording-only save         | Metadata and one changed head/body, with exact deltas; no fact chunks or unrelated heads/bodies.                                                                                                    |
| Structure result          | Exact sum of projected native item sizes, maintained by changed-item delta, plus 64 KiB result reserve.                                                                                             |
| Content / mutation result | One admitted revision and head, checked ownership/revision identity; content carries source scope, mutation results carry the global watermark.                                                     |
| Historical full snapshot  | Actual referenced revision wrappers + source chunks + manifest/template source metadata + 64 KiB; at most 4,000 revision gets plus metadata and 64-query reserve.                                   |

Arrays remain at most 8,192 entries; blocks/manifest/result membership stay below this.
Generated numbered source units live in binary facts rather than a persisted array that
could exceed 8,192. Full readers batch revision gets by 64 and preserve the existing
4,096-query and 32,000-document ceilings. Every write group checks remaining native
transaction metrics. Assigned ID lengths, adversarial parent/access metadata and
native platform enforcement still require an authorized deployment rehearsal; local
checks are not a native-boundary certification.

## Certification and strict schema

The strict schema accepts compact canonical heads and required `templateVersions.validation` only. Legacy full heads, `authoringMigrations`, `src/convex/authoringMigration.ts`, and `scripts/migrate-authoring.mjs` are removed. Uncertified companies return `ready: false` and cannot submit ordinary authoring writes; there is no ordinary-save full-audit fallback.

DOCX activation and operator bootstrap fully audit canonical heads/bodies, atomically commit the template source/manifest with a format-0 pending proof, and schedule `authoringValidation.certify` to encode/verify compact source facts and upgrade the version to format 1 before authoring becomes ready. Prepared-template source expiry and bounded company deletion drain certificates and fact chunks.

## Rep instructions and buyer explanations

The Rep (`/template`) and Buyers (`/template/buyers`) editors share one source and
one version manifest (`currentTemplate` is a pure `{ companyId, versionId }` pointer;
`templateVersions` owns `authoringGeneration` and `structuralGeneration`, so mutable
in-place saves do not rewrite `currentTemplate`). Every business body, stored
`playbookItems` head (indexed by `by_companyId_and_audience`), and transported structure
carries an explicit `audience: 'rep' | 'buyer'` discriminator, and all authoring endpoints
require an explicit `audience` argument. Rep bodies hold required `instructions`,
`approvalPolicy`, and concessions; buyer bodies contain only `audience: 'buyer'`, a
text-only `textTrigger`, and `explanation`. Compact geometry retains tag 1 for reps
and tag 2 for buyers; decoding validates that it matches `head.audience`. The packed
bytes contain no wording, and the audience is immutable for an existing item ID.
All overlap/ownership audits partition by audience via `by_companyId_and_audience`,
so buyer ranges can overlap rep ranges without changing concession ownership and
neither audience reads or decodes the other's heads. `readValidationFacts` and `templateSourceValidationChunks` are write-path-only (structural authoring saves, multi-concession conflict checks in `contracts.save`, and comment invalidation in `discussionInvalidation.ts`), never read by interactive queries. Snapshot byte/read accounting and cleanup cover
both audiences through the existing revision and manifest machinery, with required
`headReadBytes`, `structureResultBytes`, `authoringGeneration`, `structuralGeneration`,
`renderKey`, and `currentRevisionId` fields across live version/revision/receipt rows.

Each audience has its own instance of the shared membership-scoped authoring session,
including drafts, selection, preloads, retries and retained recovery. The shared editor
keeps `RepInstruction` and `BuyerExplanation` as a `TemplateItem` union throughout
drafts, dirty checking, save payloads/results, conflicts and retained recovery. Buyer
drafts use `explanation` directly; rep drafts use the same canonical `instructions`,
`approvalPolicy` and concessions as saved bodies. The four ordinary instruction fields
retain exact nonblank strings and omit blank/whitespace-only entries (enforced both by
normalization and `validateTemplateItemContent`), matching approval guidance. Every rep
item requires at least one nonblank instruction field, required approval guidance, or
concession. Approval guidance is rendered separately after those fields, under
**Changes need to be approved**. Nonblank guidance sets `{ kind: 'required', instructions: exactText }`;
clearing or whitespace-only guidance sets `{ kind: 'none' }`. Dirty checks, saved/remote
adoption, retained recovery and read-only panels all read the canonical policy directly.
Shared lifecycle code uses `TemplateAudience` and neutral item names.
The shared save transport emits the matching business body without an audience adapter.
Buyer queries require template management permission and reject IDs from the other audience.

Never build old contract captures from the current template. Normal writers count actual
canonical revision wrappers, historical snapshot JSON and decoded structures; wording-only
saves continue to leave structural generations independent from content revisions.

The terminology change preserves stored field names, table names, IDs, revision bodies,
frozen versions and both binary codecs. Saves and deletes use
`playbookItems.saveTemplateItem` and `deleteTemplateItem`.
User copy, including recovery/error/loading/accessibility text, calls rep content
instructions and buyer content explanations. Rep coaching such as
`howToExplainToBuyers` remains part of rep instructions.

## Disposable frontend read storage

The scoped workspace-read database uses
`dinu:workspace-read:v2:<deployment>:<profile>:<membership>:<company>`. IndexedDB schema 3
preserves its `projections`, `contractDirectory`, `buyerLinkDirectory`, and `directoryMetadata` stores alongside `templateSources`, `templateViews`,
`templateDetails`, and small `templateMetadata` budget/reference records.

`templateSources` stores prose once per fingerprint. A `templateViews` entry is the latest
complete ready structure for one audience, including the **actual** source ID (valid null
for an empty source), fingerprint, authoring/structural generations, timestamp and payload
reference. A source-only response has no source ID and never invents one. Only a matching
accepted source plus complete current structure is persisted. At most two envelopes and
their referenced prose payloads occupy 16 MiB encoded; preview age is seven days. Source-only
creation demand reads only prose; audience demand hydrates only its coherent pair. Live
requests start first and never await storage. Disk restoration supplies reading, never a
current observation or authoring certification.

Pair replacement, aggregate accounting, removal of an evicted audience's bodies and pruning
of unreferenced prose happen in one transaction. Oversized candidates are skipped before
other useful pairs are evicted. Runtime guards check payload shape, audience/company,
readiness, actual ID/fingerprint, generations, bounded item counts, sizes and timestamps.
The metadata store carries sizes/references; writes do not read or serialize all retained
source/detail payloads just to total a budget. Requested disk payloads are validated on read.
Optional storage open/read/transaction deadlines are 250 ms; failure leaves network,
rendering and save/leave handling independent.

Only bodies that were actually selected/opened enter `templateDetails`. Its exact key is
`[audience, sourceId, fingerprint, itemId, companyId, creationTime, contentRevision, renderKey]`.
There are at most **eight bodies and 4 MiB across both audiences together**, with a seven-day
age and LRU ordering by actual open time. A body must match a coherent ready envelope and
every head field; the current complete structure takes precedence over retained/disk state.
Changed source identity, newer head revision, absent membership, role loss or explicit
rejection invalidates/withholds the corresponding body. No draft, pending operation,
observation epoch, page, DOM node or geometry is persisted.

The membership source owns a small keyed deferred-work queue. After useful prose is
presented, it coalesces accepted view/opened body changes, waits two paint frames, respects
the existing 250 ms input/scroll cooldown, and admits one changed record per task. Equal
accepted payloads and lease churn do not serialize bodies; source sizes are reused by
object identity. Transactions use stored byte/reference metadata for eviction. This bounds
retained encoded capacity, rather than promising a heap or frame-time ceiling for a large
individual record. Scope teardown cancels callbacks; scope/accepted-version fences are
checked again before queued work and transaction writes. Permission loss removes audience
views/details; the existing account/workspace lifecycle purges the entire scoped database.

The bounded session pool remains the only memory detail cache. Releasing/recreating a
listener invalidates its observation even if a body remains readable. Selected/save pins,
last-eight opens, nearby semantic order, remaining structure order, the eight-first-response
pump and foreground bypass retain their priorities. Only successful current content
observations can enter editable/recovery/acknowledgement paths. Source-ID equality is
mandatory there: equal fingerprints under different IDs permit prose reuse only.
