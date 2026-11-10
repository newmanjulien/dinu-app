# Template storage

Current architecture: [data model](data-model.md). Release mechanics: [production releases](deployment.md).

Each company owns a permanent template source in ordered chunks and compact live playbook
heads. Revision bodies are the sole business-content authority. Heads contain company,
revision/replay identity, stable render identity and packed structure, excluding wording.
Historical projections preserve original item IDs and timestamps after live deletion.

A template version stores the template source, ordered revision manifest, mutability, counts,
exact historical JSON/native read totals and company-monotonic authoring/structural
generations. A current pointer selects it. First contract capture permanently freezes
the version; later authoring creates a mutable successor. Deleting a contract does not
unfreeze captured history.

Ordinary create/update/delete uses changed-content validation and exact deltas. Structural
changes additionally validate against certified compact source facts and heads. Ordinary
saving reads no template source prose, hydrates no unrelated instruction bodies, and performs
no full-playbook compilation or snapshot serialization. Bulk acceptance and migration
retain full audits. See [template authoring storage](template-authoring-storage.md) for the
private codec, admission reasoning, read APIs and required conversion sequence.

`contracts.state` returns compact current metadata and the captured version ID.
`templates.current` returns only the current pointer's version ID;
`templates.content` resolves the authorized version's content as
`{blockCount,itemCount,blocks,items}`. Full reads resolve ordered revisions in
bounded batches; selected reads fetch only the chosen revision bodies. Every
resolved revision must match its version's company and original item identity.

## Template source integrity encoding

Template saving derives the permanent source fingerprint and `blocksJsonBytes` from one canonical UTF-8 JSON encoding. Field ordering is canonical; array/source order is preserved. DOCX preparation and atomic operator bootstrap set both values together; chunk writing owns native chunk count/read-byte accounting. Readers retain ownership, sequence, completeness, count, read-byte and fingerprint checks. Stored values and chunk layout are unchanged, with no additional schema/cache/reset consequence. JSON byte length remains separate from native document/transaction admission. Native boundary, concurrency and remote operator behavior require separate verification.

## Template source indexing

The in-memory `SourceIndex` contains source units/coordinates/containers/gaps, ordered blocks, block ordinals, numbering-item lookup and template source addresses. One `CompiledDocument` validates and owns the accepted template source; `DocumentDomain` retains it until template source content changes and shares its index with rendering/prewarming. Reference validation and range checks reuse those lookups. Composition derives separate active numbering and merge aliases only when paragraph structure changes, reusing indexed template source addresses otherwise. It stores template source-valid reference patterns and stable targets; editor display and effective export use composed numbering and merge aliases. Private certified validation facts persist only the source coordinates and numbering rules needed for authoring. Rendering still uses the full in-memory source index; compact facts do not supply display content.

## Browser persistence

An open editing session establishes fresh contract metadata and current access before admitting cached content. Speculative warming can reuse disposable cached metadata; it does not authorize opening or confirm edits. Shared version flights and object identity serve preview, creation handoff, opening and warming. Cancellation of one consumer preserves other consumers' shared read.

Memory/disk caches retain their 24-contract/24-version and combined 32 MiB bounds, optional-storage fallback, bounded deadlines, malformed repair and metadata-only updates. Confirmed IndexedDB format **11** ([runtime](../src/lib/contract/snapshot-storage.ts)) deletes and recreates obsolete snapshot/metadata stores on upgrade. These caches are disposable; upgrades never clear the separate sessionStorage intent journal. Explicit bounded persisted checks share saved-state validation with draft recovery. Confirmed metadata updates include complete reviews while retaining immutable identity and metadata-only disk writes. Desktop Chrome/Edge and Safari are primary.

The tab-scoped intent journal uses the `dinu:drafts:v4` key namespace, scoped to deployment, Clerk user, membership and contract. The namespace is separate from the payload format: the [reader](../src/lib/contract/draft-recovery.svelte.ts) accepts versions **4, 5 and 6**. The [current writer](../src/lib/contract/persistence.svelte.ts) emits version **5** while retaining legacy intent or a request without commands, and version **6** otherwise. It never adopts older namespaces. Malformed checkpoints are refused, and confirmed-cache retirement cannot take ownership of pending intent.

Draft command queues are bounded to **250** commands and each retained request to **25**. Version 6 requires a draft command array and, when a request exists, its command array; versions 4/5 allow their absence and validate them when present. Command IDs must be unique within each array, nonblank and at most 200 characters; item IDs, finite occurrence times and choices are validated, and unexpected fields are refused. Retry operation IDs, application IDs, command IDs and occurrence times, and expected edit revisions round-trip unchanged. Explicit contract, user or membership discard clears the current checkpoint; deletion prevents late transport outcomes from recreating it.

## Capacity and lifecycle

Existing bounds remain: 4,000 rules, 4,096 template source blocks, 500,000 business JSON bytes
per rule, 8,000,000 historical JSON bytes and 1,024 selected concessions. Native limits
apply independently. Exact referenced revision/source totals, compact-head totals and
structure-result totals are maintained in the authoring transaction. Late mutable markers
update their owning version before commit. All write groups retain native capacity and
rollback checks. Native boundaries and concurrency require an authorized deployment
rehearsal; details and reserves are in [the admission ledger](template-authoring-storage.md#physical-layout-and-admission-reasoning).

Prepared DOCX conversion is separate from accepting the permanent company template.
Activation reserves the template source metadata write and leaves canonical chunks,
fingerprint, and native byte totals unchanged. First-version validation remains
unconditional in the same atomic mutation, so a failed validation also rolls back
activation.

Canonical paragraphs store title/heading/body roles independently of legal numbering.
Prepared content retains the roles assigned automatically during parsing; activation
uses those same blocks without a separate review or override record.
See [paragraph roles and migration](document-formatting.md).
`templates.activate` atomically changes the template source to `active`, records
`activatedAt`, establishes company template source ownership, and saves the initial
version/pointer. The UI calls this action “Go to last step” and opens the editor.
Instruction saves update the current template automatically. Originals and
preparation expiry retain their existing lifecycle. Operator bootstrap uses the
same canonical writers and refuses changed/incomplete state; `operator.readSeed`
provides the live business projection and a `snapshot` projection for independent
reconciliation. New business data commits atomically and source facts are certified in a scheduled readiness step; existing full heads require the bounded authoring migration before authoring is admitted.

Live rule/contract deletion retains referenced immutable history. Company deletion drains source/fact chunks, private certificates, migration state, rules, receipts, versions, revisions and retained originals through its bounded worker. Cleanup includes durable bounded child deletion and all-kind orphan recovery. Native failure, concurrency, storage and sweep-frontier behavior require separate verification.

Word export uses private selected-rule capture with the complete template source/manifest and unchanged access/revision/version/lifecycle/approval finalization. Only selected historical rule bodies are read. Approved joined newline semantics are independent of unused highlights. Public snapshots and cache formats are unchanged. Native file retirement, browser behavior and Word visuals require separate verification.

## Verification

See [performance checks](performance-checks.md) for automated guarantees. Native
resource boundaries, browser cache behavior and Word visual output require separate
verification.

## Static tables

Tables store plain strings, and composition returns them unchanged. Cell source keys,
live references and historical cell edits are unsupported. The existing reset databases
already use this shape; no table-source mapping or restoration stage is needed.

## Readability conversion tools

The separate readability conversion tools remain available for explicit development/local
rehearsal of stored-record renames. They are not part of the static-table cleanup.
`scripts/readability-transition.mjs` prepares/restores the temporary transition schema;
`scripts/migrate-readability.mjs --company-id COMPANY_ID --deployment EXACT_NAME`
converts scoped rows and recomputes version accounting. This includes existing
template source `published` states and `publishedAt` timestamps becoming `active` and
`activatedAt`, template `publishedAt` becoming `updatedAt`, and item
`publishedRevisionId` becoming `currentRevisionId`. IDs, timestamps, current
pointers and captured contract versions are preserved. Existing records must be
converted under the transition schema before restoring strict validation.
The runner refuses production,
and normal strict-schema conversion functions refuse calls. These tools do not deploy,
reset or seed. Native migration resumption, transaction limits and restoration remain
unverified; use the separately reviewed release procedure for an authorized target.

Buyer link captures reuse the saved contract's frozen template version; they never
copy or later resolve mutable live playbook heads. Captures store only selected IDs
and fixed eligibility, reserving native document bytes for the maximum future
readiness payload. Public projection includes template source blocks, independently authored buyer explanations
and their targets, and released operations only. Rep Summary and negotiation guidance
never supply buyer explanation wording. A frozen version captures both audiences;
versions without buyer explanations remain empty. Rep geometry validates the released changes independently of buyer annotation ranges.
Buyer highlights follow surviving source text and cover replacement text only when
the buyer range contains the entire replaced source range. Explanations with no
visible highlighted text are hidden. Each buyer renderer has
an immutable effective view; existing workspaces retain redlines. Composition identity
already includes the view, and buyer alternative prewarming is disabled.

Buyer screen and DOCX use the same captured changes. Export uses existing composition
and Word generation, followed by a fresh latest/company/contract/eligibility check
before returning attachment bytes. No public storage URL or rep export event is created.
