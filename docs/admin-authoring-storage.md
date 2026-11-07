# Admin authoring storage and cutover

`/admin` reads compact structure independently of source prose and instruction
bodies. This document describes the implemented storage boundary and the source-only
conversion tools. It does not record a deployment or a completed live-data migration.

## Authorities and read surfaces

`playbookItemRevisions.body` is the sole business-content authority. A normalized
`playbookItems` head stores company/revision/replay identity, a stable `renderKey`,
and a private binary structure projection. It contains no instruction prose or
replacement wording. Existing head IDs/timestamps remain unchanged. New render keys
use the creation operation UUID; converted records use their original item ID. Creation
receipts reserve each UUID within the company, including after deletion, so another membership
cannot publish a colliding annotation identity.

`playbookItems.currentStructure` returns the baseline fingerprint, authoring and
structural generations, readiness, and the complete annotation/geometry projection.
`playbookItems.detail` joins one head and revision and returns an explicit present
or missing result at the same kind of watermark. Definitive conflict responses include
the transactional target/revision and the same authoring watermark. The client keeps this
small recovery witness independently of the original immutable retry operation; restore
uses current structure/detail agreement with its revision and freshness floor. Source
loading/errors remain client states. `baselines.authoringSource` returns blocks and their fingerprint atomically.

The active admin authoring session eagerly warms a bounded pool of live detail subscriptions
as soon as the loaded baseline matches ready structure, before renderer interaction or a first
selection. Documents that fit the pool warm every instruction. Optional retention is limited to
64 item IDs, eight subscriptions awaiting their first response, and 4 MiB of encoded retained
records. The byte budget excludes unknown first responses, pinned records and object/client
overhead; it is not a heap limit. Pending selection, actual editor and submitted-operation
targets are pinned independently. Completed editor-owner transitions immediately count demoted
records against the optional limits; a pending switch keeps the previous editor pinned.
Closing/switching retains useful live details, prioritizing the last eight admitted real
selections/opens (including successful existing-item restores), nearby pages in semantic source
order, then remaining structure order. Byte-pressure admission stops lower-priority warming
for that ranking instead of repeatedly refetching.

Nearby demand reuses the highlight controller's visible-plus-adjacent-page signal and semantic
annotation registry memberships, including boundary/bookmark anchors and grouped controls.
It rebuilds after owners commit or boundary controls return from location picking. Each eligible
reporting lifetime receives current-page demand again, including after a same-baseline read
restart without scrolling; reports from a retired lifetime cannot change current priorities.
Only selected/save-confirmation bodies enter the document source; background arrivals do not
change that projection or paginate. Optional errors stay outside foreground error/leave logic.
An accepted successful current read retires only that item's failed-read suppression, without
relaxing authority checks or optional budgets. Inactive, paused, blocked, frozen, suspended or
mismatched-baseline workspaces release optional subscriptions and invalidate nearby reporting.
Release/retry/restart invalidates observations: a recreated listener must respond before its
body can satisfy authority, recovery or new acknowledgment checks. Global-generation and
exact head-revision checks remain mandatory even for retained bodies. A cold selection uses
the existing anchored editor rail/sheet while waiting, with no normal-flow loading row.

The compatibility `playbookItems.current` list follows the ordered revision manifest
directly. It does not scan all heads before reading every body. Revision wrappers
carry the replay/render metadata required by this adapter; historical snapshots
continue projecting only the original business fields and identities.

`baselineAuthoring` contains one small indexed certificate per baseline: fingerprint,
codec version, ordered fact-chunk IDs, counts and exact native bytes. Keeping this
separate preserves the native document envelope of baselines whose DOCX issue arrays
already approach 1 MiB. `baselineValidationChunks` holds bounded private binary data.
Facts contain source coordinates, block/container order and table barriers, numbering
sequence/parent/depth and a nine-bit numeric-token mask. They omit source/display text.

Full-source and compact validators consume `ValidationSourceFacts`. Bulk source
acceptance checks the complete baseline, references and address ambiguity. Its atomic
business commit carries an audited format-0 pending certificate. An idempotent scheduled
source-only mutation encodes/decodes facts, compares every coordinate/key/reference fact,
and upgrades the version to format 1 before authoring becomes ready. Ordinary saves
verify the certificate/fingerprint/counts without reading or hashing baseline prose.

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
when trigger/concession geometry changes. Prose saves may recompute a compact query;
this is not a promise of zero query invalidation.

## Physical layout and admission reasoning

The product bounds remain 4,096 baseline blocks, 4,000 rules, 500,000 business JSON
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
  names, instruction/replacement wording and reference-display patterns. Paragraph
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

| Surface                  | Counted work                                                                                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary structural save | Exact compact-head total + fact-chunk total + certificate/version/baseline metadata + 2,100,000 bytes for changed head/body and access work; document/read/query/write checks remain active. |
| Instruction-only save    | Metadata and one changed head/body, with exact deltas; no fact chunks or unrelated heads/bodies.                                                                                             |
| Structure result         | Exact sum of projected native item sizes, maintained by changed-item delta, plus 64 KiB result reserve.                                                                                      |
| Detail/result            | One admitted revision and head, original identity and watermark; ownership/revision joins checked.                                                                                           |
| Compatibility list       | Revision total minus baseline chunk reads, manifest/metadata, conservative 128 bytes per live projection and 64 KiB reserve; no source chunks or heads.                                      |
| Historical full snapshot | Actual referenced revision wrappers + source chunks + manifest/baseline metadata + 64 KiB; at most 4,000 revision gets plus metadata and 64-query reserve.                                   |

Arrays remain at most 8,192 entries; blocks/manifest/result membership stay below this.
Generated numbered source units live in binary facts rather than a persisted array that
could exceed 8,192. Full readers batch revision gets by 64 and preserve the existing
4,096-query and 32,000-document ceilings. Every write group checks remaining native
transaction metrics. Assigned ID lengths, adversarial parent/access metadata and
native platform enforcement still require an authorized deployment rehearsal; local
checks are not a native-boundary certification.

## Conversion and operational sequence

The schema accepts original full heads only for conversion. Canonical writers always
write normalized heads. Uncertified/migrating companies return `ready:false` and cannot
submit ordinary authoring writes. There is no ordinary-save full-audit fallback.

The internal `authoringMigration` API is resumable:

1. `begin` captures baseline fingerprint/version/generation, audits source and all
   manifest bodies, certifies source facts and raises the company authoring barrier.
2. `step` converts at most eight head/body pairs per transaction, checks original head
   business equality and all identity/revision links, preserves replay metadata, removes
   duplicate head bodies and accumulates exact compact/read/result totals.
3. Further `step` calls recount one historical version per transaction, because adding
   compatibility metadata to a shared revision wrapper changes its native read size.
   Historical business JSON, item IDs/timestamps, manifests and captured versions persist.
4. `finish` checks complete compact membership, unchanged capture, source certification
   and all read envelopes, advances generations, certifies the current version and
   releases the barrier atomically. Repeated completed calls acknowledge completion.

A development/local rehearsal runner is available after deploying the additive schema:

```sh
node scripts/migrate-authoring.mjs --company-id COMPANY_ID --deployment EXACT_NAME
```

The runner validates the exact configured target, refuses production, does not deploy
or seed, stops on a failed transaction and resumes durable progress on explicit rerun.
Production conversion requires the separately authorized release procedure and backup.

DOCX activation and operator bootstrap fully audit canonical heads/bodies, atomically
commit the baseline/manifest and schedule source certification. The format-0 pending
proof is private to that canonical writer; it cannot certify arbitrary legacy data.
Reviewed baseline repairs invalidate current version certification; rebuild facts in the
separate migration transaction and recount/recertify before reopening authoring. Prepared-baseline expiry and bounded
company deletion drain certificates, fact chunks and migration state. Company-final
cleanup also catches deletion workers that had already passed newly added phases.

The legacy full-head schema branch and migration entry points must remain until every
company has completed conversion and old releases have drained; tightening that schema
before conversion would make deployment fail. Normalized companies retain no duplicate
business body in heads. No live conversion or schema tightening has been performed here.
