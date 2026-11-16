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

Every mutable body writer rechecks the company's current pointer and the owning
manifest's `mutable` state. Replacement also verifies exact item/revision ownership
and the next content revision. A stale `mutableVersionId` on a body grants no write
authority after capture. Captured-contract readers require a frozen manifest.
Manifest generations are authoritative; pointer generation fields are compatibility
projections and fallback values for older manifests.
Observation, authoring validation, migration captures and source repair use the same
safe nonnegative integer resolution. A present clock never depends on mirror equality.
Ordinary writes mirror manifest clocks for compatibility; field removal waits for the
[clock/capture population gate](deployment.md#backend-ownership-conversion).

Ordinary create/update/delete uses changed-content validation and exact deltas. Structural
changes additionally validate against certified compact source facts and heads. Ordinary
saving reads no template source prose, hydrates no unrelated template item bodies, and performs
no full-playbook compilation or snapshot serialization. Bulk acceptance and migration
retain full audits. See [template authoring storage](template-authoring-storage.md) for the
private codec, admission reasoning, read APIs and required conversion sequence.

`contracts.state` returns compact current metadata and the captured version ID.
`templates.current` returns only the current pointer's version ID.
`templates.preview` reactively reads the current version, including edits under the same ID.
`templates.frozenContent` rejects mutable versions and supplies contract snapshot caching;
`templates.content` remains a general authorized version read. The content shape is
`{blockCount,itemCount,blocks,items}`. Full reads resolve ordered revisions in
bounded batches; selected reads fetch only the chosen revision bodies. Every
resolved revision must match its version's company and original item identity.

## Template source integrity encoding

Template saving derives the permanent source fingerprint and `blocksJsonBytes` from one canonical UTF-8 JSON encoding. Field ordering is canonical; array/source order is preserved. DOCX preparation and atomic operator bootstrap set both values together; chunk writing owns native chunk count/read-byte accounting. Readers retain ownership, sequence, completeness, count, read-byte and fingerprint checks. Stored values and chunk layout are unchanged, with no additional schema/cache/reset consequence. JSON byte length remains separate from native document/transaction admission. Native boundary, concurrency and remote operator behavior require separate verification.

## Template source indexing

The in-memory `SourceIndex` contains source units/coordinates/containers/gaps, ordered blocks, block ordinals, numbering-item lookup and template source addresses. One `CompiledDocument` validates and owns the accepted template source; `DocumentDomain` retains it until template source content changes and shares its index with rendering/prewarming. Reference validation and range checks reuse those lookups. Composition derives separate active numbering and merge aliases only when paragraph structure changes, reusing indexed template source addresses otherwise. It stores template source-valid reference patterns and stable targets; editor display and effective export use composed numbering and merge aliases. Private certified validation facts persist only the source coordinates and numbering rules needed for authoring. Rendering still uses the full in-memory source index; compact facts do not supply display content.

## Browser persistence

An open editing session establishes fresh contract metadata and current access before admitting cached content. Speculative warming can reuse disposable cached metadata; it does not authorize opening or confirm edits. Shared frozen-version flights and object identity serve creation handoff, opening and warming. Live previews stay outside this cache; creation reads the captured frozen content before adopting its prepared document resource. Cancellation of one consumer preserves other consumers' shared read.

Confirmed namespace `dinu:v8` retains memory/disk 24-contract/24-version and combined 32 MiB bounds, optional-storage fallback, bounded deadlines, malformed repair and metadata-only updates. Confirmed IndexedDB format **16** ([runtime](../src/lib/contract/snapshot-storage.ts)) deletes and recreates obsolete snapshot/metadata stores on upgrade. These caches are disposable; upgrades never clear the separate sessionStorage intent journal. Explicit bounded persisted checks share saved-state validation with draft recovery. Confirmed metadata updates include complete reviews while retaining immutable identity and metadata-only disk writes. Desktop Chrome/Edge and Safari are primary.

The tab-scoped intent journal uses `dinu:drafts:v6`, scoped to deployment, Clerk user, membership and contract. The [parser](../src/lib/contract/draft-values.ts) and [writer](../src/lib/contract/persistence.svelte.ts) write envelope **12**, with independent confirmed `base`, ordered native Playbook `commands`, immutable in-flight `request`, `conflict` and `blocked` state. Every command captures its exact expected current change ID and set/withdraw action. Recovery preserves exact submitted IDs/input and refuses conflicts on touched items; unrelated changes can merge. Old envelope 10/11 and malformed bytes remain raw, blocked and exportable in the same journal namespace. The immutable retry deadline is original identity time plus seven days; server rejection or local expiry blocks automatic recovery without deleting original intent. An explicit saved-state review precedes a new deliberate request. Live buyer names stay outside journal state.

Old executable protocols are fenced under the [preservation cutover](backend-preservation-cutover.md). Envelope 10 and malformed originals in the same journal namespace remain blocked for review/export; no automatic translator, fresh timestamp or replay exists. Disposable cache retirement never clears intent. Current-schema malformed or conflicting intent remains recoverable, with memory fallback and exact original request bytes. An apparent choice match alone is not acknowledgment of a submitted operation. Download acknowledgment has its independent `dinu:download-acks:v2` namespace.

Draft queues are bounded to **250** commands and each retained request to **25**. Commands have unique `op1:<original milliseconds>:<UUIDv4>` identities within each array, valid item/change identities, finite occurrence times and no unexpected fields. Complete queues must preserve latest intent before and after acknowledgment; bounded overflow retains its full authoritative target. Both transport and live-last-operation acknowledgment preserve newer work. Explicit contract, user or membership discard clears the current checkpoint; deletion prevents late transport outcomes from recreating it. Disposable confirmed-cache eviction never clears pending intent. Real historical corpus and browser storage behavior still require cutover validation.

## Capacity and lifecycle

Existing bounds remain: 4,000 rules, 4,096 template source blocks, 500,000 business JSON bytes
per rule, 8,000,000 historical JSON bytes and 1,024 selected concessions. Native limits
apply independently. Exact referenced revision/source totals, compact-head totals and
structure-result totals are maintained in the authoring transaction. Late mutable markers
update their owning version before commit. All write groups retain native capacity and
rollback checks. Native boundaries and concurrency require an authorized deployment
rehearsal; details and reserves are in [the admission ledger](template-authoring-storage.md#physical-layout-and-admission-reasoning).

Pending DOCX conversion is separate from releasing the permanent company template.
A provider-confirmed setup booking admits optional upload. Successful parsing
atomically stores `company.pendingTemplateSourceId`, immutable chunks, fingerprint,
original DOCX and attribution. Pending sources expire 90 days after upload;
identical retry reuse never extends that deadline. Replacement first adopts the
new source, then drains the previous one. Matching-pointer checks protect a newer
upload from an older expiry job. Uploader departure and booking cancellation do
not delete this company-owned source.

Canonical paragraphs store title/heading/body roles independently of legal numbering.
Release keeps the roles assigned automatically during parsing, without a separate
review or override record. See [paragraph roles](document-formatting.md).
Internal `operator.releasePendingTemplate` checks the exact company/source/fingerprint,
current pending pointer, booking qualification, expiry and complete parse integrity.
It atomically changes the source to `active`, records `activatedAt`, establishes
company ownership, clears the pending pointer and saves the initial version through
the canonical writer. First-version validation is unconditional, so a failure rolls
back the entire release. Exact release replay returns the current version even if
the call was subsequently cancelled. Ordinary public activation is unavailable.
The current route reveals its normal editor reactively after release; instruction
and explanation saves then update the current template automatically. See the
[assisted setup operator runbook](assisted-template-setup.md).
Operator bootstrap uses the
same canonical writers and refuses changed/incomplete state; `operator.readSeed`
provides the live business projection and a `snapshot` projection for independent
reconciliation. New business data commits atomically and source facts are certified in a scheduled readiness step; active repair/recount/recertification uses `authoringMigration.begin/step/finish`. Legacy full heads are rejected by the strict schema and require separate G19 old-bundle clearance before release.

Live rule/contract deletion retains referenced immutable history. Company deletion drains source/fact chunks, private certificates, migration state, rules, receipts, versions, revisions and retained originals through its bounded worker. Cleanup includes durable bounded child deletion and all-kind orphan recovery. Native failure, concurrency, storage and sweep-frontier behavior require separate verification.

Seller Word and HubSpot preparation reserve the ready approved document under an independent `contractOutputs` owner. Its manifest owns separately paged immutable dependency/decision/actor proof; bounded retry receipts retain references and private preparation only until transfer/disposal. Authorization, exact readiness, canonical source identity, destination and eligibility are checked at preparation and before each new URL release or dispatch. Approved joined newline semantics are independent of unused highlights. Native file retirement, browser behavior and Word visuals require separate verification.

## Verification

See [performance checks](performance-checks.md) for automated guarantees. Native
resource boundaries, browser cache behavior and Word visual output require separate
verification.

## Static tables

Tables store plain strings, and composition returns them unchanged. Cell source keys,
live references and historical cell edits are unsupported. Target shape/populations must be classified from current factual inventory; historical reset evidence supplies no release clearance.

## Retired conversion tools

Retired contract conversion/recovery runners and their dated runbooks describe superseded models. The strict application has no permanent retained-contract translator. The separately preserved one-off [current-schema preservation kit](backend-preservation-cutover.md) retains original history; older/unknown targets stop for their actual-schema plan. Local implementation performs no conversion/reset/deployment.
Active authoring migration, source/paragraph repair, seed transport and the independent
historical reconciliation oracle remain available; their own release procedures still apply.

Buyer current views reuse the contract's frozen original template and the same approved document as the seller. Public rendering receives actual structured wording and allowlisted piece origins, discussion anchors and explanation geometry. It never replays pending template choices. Template guidance remains private. Approved buyer wording checks the complete annotation footprint; invalid widgets and explanations are hidden together.

Buyer rendering shows current wording; dashboard redlines compare that wording with the frozen original. The same actual document drives DOCX generation. Buyer downloads independently recheck live link/company access and the displayed current identity before final release. Static tables are rendered and exported unchanged and cannot be editing targets.
