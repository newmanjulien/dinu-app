# Contract core rewrite

Historical work log. Its draft/successor and publication-based seller-export model is superseded by [the current data model](../data-model.md), [lifecycle](../lifecycle.md) and [retained rollout gates](../deployment.md#backend-ownership-conversion). This log is not a deployment or conversion certificate.

> Historical implementation/review snapshot. Recorded results describe that stage only.
> Contract conversion, tuple-chunk and compatibility instructions below are superseded by
> the [current contract release procedure](../deployment.md#backend-ownership-conversion).
> Read the current architecture in [data model](../data-model.md); no live cutover is certified here.

**Status: local implementation complete.** Final verification passed: 184 existing
automated checks, 24 historical wording scenarios with zero unexplained mismatches,
backend/application/tools TypeScript, production build and loading dependency boundaries.
No new tests or browser automation were added. Deployment and database wipe remain separate;
browser behavior, live Convex capacity/concurrency, real provider delivery and large
multi-batch retained-snapshot cleanup are not certified by these local checks.

## Scope and decisions

- Implement the accepted contract redesign: one approved structured document, immutable changes/publications, independent dashboard and buyer reviews.
- Preserve the existing screens, annotations, discussion behavior and exports; remove review reset globally. Tables remain static.
- No backwards compatibility or data migration. Deployment and coordinated database wipe are separate operational cutover steps.
- Treat the extensive existing uncommitted work as the baseline. No new tests or browser automation.

## Ownership

- `contract_core`: schema, version/document storage, shared structured snapshot and exact change engine.
- `contract_workflows`: saving, approvals, independent reviews/email, readers, publication, buyer acceptance.
- `contract_exports`: exports, cleanup, seeds and obsolete contract migrations.
- Root: client rendering/persistence/recovery, reset UI removal, integration, documentation and local verification.

## Validation required

- Mandatory existing performance suite for saving/cache changes.
- Backend TypeScript, application/tool checks and production build.
- Necessary existing contract/integration suites; maintain original guarantees when fixtures change.
- Report verified and unverified behavior. No deployment or database mutation during local verification.

## Progress

### Historical integration checkpoint (root, 2026-11-11)

- Core and workflow implementation are complete; exports/cleanup/seed integration is now
  complete as well. The sole export subagent is inspecting the remaining offline seed repro.
- Client rendering uses materialized documents; frozen-original redlines and immutable
  discussion coordinates are integrated. Global review reset is removed.
- Local preview basis is cached by version/widget/revision, refreshed serially for local
  changed widgets after concurrent metadata updates. Hidden active conflicts have an explicit
  withdraw action. Other UI remains unchanged.
- Save commands compare touched-widget expectations and rebase unrelated changes. Draft
  envelope v8/namespace v5 has no historical converter. Fixed save drain waiting when a live
  acknowledgment precedes the network response, preserving account-exit guarantees.
- Latest application/tool checks: zero errors/warnings. Mandatory performance: 39/39 pass.
  Full lifecycle: 79/80 passed plus SSR 5/5; the sole failure was an exact subscription fixture
  missing the new per-widget preview query. Fixture maintained; targeted rerun underway.
  Existing HubSpot integrations: 60/60 pass (export handoff below).
- Offline historical seed oracle exposed a zero-length insertion-placeholder capture bug.
  Fixed exact fragment capture; the original liability choice now passes. A later payment
  variant still conflicts; investigation remains necessary before build/final validation.
- No new tests, browser check, deployment, environment edit or database wipe performed.

Earlier entries below are historical handoffs and may describe already-completed integration.

### Final integration checks in progress

- Historical seed reconciliation now passes all 24 scenarios with zero unexplained
  effective-wording, accepted-redline or export mismatches. Actual dashboard input is
  round-tripped through the public render transport; the archived oracle stays independent.
- Fixed two exact-change defects: insertion gaps preserve/consume zero-length source atoms
  with their distinct immutable endpoints, and structural materialization preserves every
  untouched paragraph's original atoms and lineage. The two-empty-marker repro reverses
  exactly after replacement.
- Annotation invalidation now lives in shared `contractAnnotations`: dashboard, internal
  buyer and public publication projections hide complete affected widgets and explanations.
  Discussion validation composes actual wording without replaying original annotations.
- Materialized comment anchors use immutable piece origins rather than reusable widget/
  variant coordinates. Runtime inspection confirmed that an anchor resolves its application
  but cannot match a later application of the same variant. Full-variant/explanation hiding
  and reversal restoration also passed local runtime inspection.
- Withdrawal of a pending replacement restores published wording without recreating a
  current review. Only unsent commands on acknowledged widgets rebase to a server-normalized
  restored choice; unrelated concurrent widget changes still conflict.
- `npm run verify` passed SSR 5/5, lifecycle 80/80, performance 39/39, HubSpot 60/60,
  application/tools checks, production build and loading dependency boundaries. Targeted
  saving/lifecycle checks are being repeated after the final acknowledgment repair.
- Backend TypeScript passed. Dead prior buyer-state/warning tables are receiving the final
  removal pass. No browser, provider delivery, live Convex admission, deployment or wipe.

### Final source state

- Removed the unused `contractBuyerState` and `publicationAcknowledgments` tables,
  their validators/deletion phases and unused imported-contract-history markers. Public
  projection metadata is now an explicit DTO rather than a type borrowed from a dead table.
- Removed unused buyer effect replay and replacement-anchor reconstruction helpers.
- Shared canonical JSON now governs storage, exact content comparison, piece fingerprints
  and redline reference identity. Field order cannot make persisted reference or structural
  changes fail approval/reversal. A reference replacement round-tripped through reordered
  storage JSON and reversed exactly to the original.
- Final `npm run verify` passed against this source state: SSR 5/5, lifecycle 80/80,
  performance 39/39, HubSpot 60/60, zero Svelte errors/warnings, tools checks, production
  build and loading dependency boundaries. Backend TypeScript and offline seed oracle also
  passed (24 scenarios, zero unexplained mismatches). `git diff --check` passed.
- Evidence: `/tmp/contract-rewrite-verify.log`, `/tmp/contract-rewrite-tsc.log`,
  `/tmp/contract-rewrite-seed.log`; persisted oracle report: `data/migration/reconciliation.json`.
  Deployment/database cutover remains outside local implementation.

- Read workspace rules, Convex guidelines and relevant skills; inspected the current version/selection/effect model.
- Shared document and command interfaces are being agreed before consumers switch.
- Core completed; workflows now the sole active subagent. Export/cleanup work follows it.
- Root removed global reset controls, upgraded local draft/storage envelopes without compatibility, and added per-widget command expectations. Existing fixtures are being maintained for that protocol.
- Root is integrating a materialized composer with frozen-original cumulative redlines and immutable discussion coordinates. This is in progress and not yet verified.
- Capacity decision: dashboard queries return one approved document plus pending candidate patches, avoiding two full documents in one native query result. Per-widget preview basis loads separately; public transport omits private ancestry.

## Core implementation handoff (2026-11-11)

Core files are implemented; workflow/publication/client/export integration is still in progress.
The user subsequently restricted work to one active subagent at a time. Core is the sole
subagent until its final handoff; resume workflow and export work sequentially.

### Exact pure interfaces

`src/lib/document/contract-document.ts` exports:

- `ContractDocument { blocks: SourceBlock[]; pieces: PieceLineage[]; aliases: [string,string][]; removedBlocks: string[] }`.
- `PieceLineage { sourceKey; origin: {sourceKey,start,end}; ancestors: OriginInterval[]; createdBy?; discussion?: {itemId,concessionId,changeIndex,offset} }`.
- `createContractDocument(blocks)`: validates original source and normalizes materialized block order.
- `documentIndex(document)`: indexes materialized blocks with persisted numbering aliases.
- `mapDocumentTarget(document,target,descendants = false)`: follows immutable origin intervals; descendant mapping is explicit.
- `prepareDocumentChange(document,changes,id,discussion?)`: captures exact text fragments or structural sections plus dependencies.
- `applyDocumentChange(document,patch)` / `reverseDocumentChange(document,patch)`: enforce exact current content before applying; disjoint paragraph edits survive.
- `prepareDocumentTransition(document,predecessorsNewestFirst,changes,id,discussion?)`: reverses the widget's complete approved chain in memory, prepares the new variant, then captures direct current→new changes using common immutable-origin spans and block anchors. It does not store inverse+new overlapping patches.
- `inverseDocumentChange(patch,id)`: captures an immutable approved-removal payload.
- `DocumentChange { id; dependencies; parts; aliasesBefore; aliasesAfter }` and `DocumentChangeConflict`.

`contractDocument` wire validator is exported from
`src/lib/document/contract-document-validators.ts` and re-exported by
`src/convex/contractValidators.ts`. Convex has no tuple validator; alias pair arity is
checked during internal document admission.

Grouped transport exports are ready for native query array limits:
`ContractDocumentTransport`, `contractDocumentToTransport`, `contractDocumentFromTransport`
and `contractDocumentTransport` validator. Each block has its own `pieceGroups` entry;
aliases and removed keys are grouped in `aliasGroups`/`removedBlockGroups`.
For actual UI queries use the narrower `ContractRenderTransport`,
`contractDocumentToRenderTransport` / `contractDocumentFromRenderTransport` helpers and
`contractRenderTransport` validator. This explicit allowlist retains only sourceKey,
origin and discussion, drops ancestors/createdBy, and avoids inherited ancestry array
limits. Validators are re-exported from `contractValidators.ts`.

`source-index.ts` accepts optional aliases and `compose.ts` accepts base aliases as
its fourth constructor argument. Defaults retain the original import-validation behavior.

### Immutable storage

`src/convex/contractDocuments.ts` (re-exported by `contractVersions.ts`) exports:

- `readContractDocument(ctx, documentId, scope?: {companyId,contractId})`.
- `writeContractDocument(ctx, {companyId,contractId,document,previousDocumentId?}) -> Id<'contractDocuments'>`.

Manifests/chunks are immutable. UTF8 bytes can split even a large paragraph without
corrupting Unicode. Paragraph-key chunk boundaries allow unchanged chunks to be shared;
unchanged snapshots return the preceding manifest ID. Only the final document of a batch
should be written. Reads and writes check actual remaining Convex transaction budgets;
read counters use native document sizes rather than character counts. Materialized source
retains the existing 8,000,000-byte envelope; lineage plus wrappers must fit aggregate limits.

Schema adds `contractDocuments`, `contractDocumentChunks`, `contractChanges`,
`contractIntents`, and `contractChangeContents`. Final intent table name is
**contractIntents**, matching `contractChanges.ts`. `contractVersions` now requires
`approvedDocumentId` and `baselineDocumentId`; no migration fallback is provided.

### Integration requirements / known risks

- Workflow must initialize both document IDs at creation, share approved/baseline pointers
  on publication forks, replace old `versionContext` reconstruction, wire immutable changes
  into approval/acceptance flows, and remove global reset. The old 4MB `writeVersionContent`
  path still exists until workflow replaces its consumers.
- Export cleanup must remove obsolete contract migrations and drain all five new tables.
- Seller `selectedV2` should expose actual document, candidate, items, revision and applicability
  conflicts. Public rendering must allowlist actual blocks, origin/discussion render coordinates,
  and public explanations; exclude ancestors, createdBy, policy and private history.
- Loading original baseline plus actual document in one response can exceed native 16MiB
  read/result limits at supported capacity. Load baseline separately/reuse original source.
- Internal flat `pieces` may exceed Convex's 8192-entry array cap for an otherwise supported
  template. JSON storage handles this, but query transport must group lineage per block or
  use chunks rather than silently reducing template capacity.
- No browser, deployment, database wipe, environment edit, or retained new test/probe files.

### Core evidence

- One-off runtime evaluation passed text replacement, disjoint reversal, dependency refusal,
  paragraph split/merge/insertion, numbering merge aliases across a later insertion, full
  widget variant chains, inverse payloads, and separated-span transitions. These did not add
  test-suite files.
- A 5,609,162-byte Unicode snapshot round-tripped through the storage API; 73 of 74 chunks
  were shared after a local edit; an unchanged write reused the same manifest.
- Backend TypeScript log: `/tmp/contract-core-tsc.log`. Latest core checks have no errors in
  core-owned files. Remaining integration failures are missing new required document IDs in
  `contracts.ts`, `contractPublication.ts`, and obsolete `contractVersionMigration.ts`.
- Existing mandatory performance suite: 27 passed, 12 failed in saving/creation because
  pending workflow creation and existing fixtures lack the newly required document IDs.
  Root owns fixture maintenance after integration; no assertion was weakened. Detailed log:
  `/tmp/contract-core-perf.log`. Full application verification remains root work after
  sequential workflow/export integration.

## Workflow implementation handoff (2026-11-11)

Workflow changes are integrated. Root owns client integration/fixtures and the next sequential
agent owns export/cleanup. No deployment, browser, wipe, or new tests were performed.

### Workflow outcomes

- Creation materializes original structured wording and initializes both document pointers.
- `changeSession` stages immutable exact patches, applies/reverses decisions, restores approved
  predecessors on withdrawal, and persists only one final approved document for a save batch.
- Saving validates ordered per-widget `expected` choices; unrelated edit revisions merge.
  Null on an approved widget stages removal governed by frozen policy; null on a pending or
  rejected replacement withdraws it. Buyer approved undo is refused.
- Publication seals Vn and creates Vn+1 sharing its document manifest; carries only approved
  heads with no new current review identity. Pending/rejected active rep/buyer changes block.
- Dashboard and buyer generations/completions remain separate. Delivery eligibility checks
  captured pending identities still belong to current intent; source mutation/deletion no
  longer retracts copied buyer acceptance.
- Proposal acceptance resolves the exact immutable source anchor in both published source
  and draft approved/candidate documents. It copies a stable patch; approval does not reread
  mutable source messages. Unrelated comments never become blockers.
- Annotation invalidation checks trigger plus EVERY variant target against approved buyer
  footprint. Entire IDs are hidden; active hidden intent appears in applicabilityConflicts.
- Removed `advanceApprovedState` effect replay/no-op and backend review-reset paths. The old
  `writeVersionContent` helper remains solely for the obsolete migration that export cleanup
  must delete; actual reads use materialized snapshots.

### Final client contracts

- `contractDefinitions.selectedV2` returns `{document:ContractRenderTransport,
candidatePatches:string,items:contractItem[],revision:number,hiddenItemIds:string[],
projectedTargets:[{itemId,trigger,choices:[{id,targets:SourceTarget[]}]}],
applicabilityConflicts:string[]}`. `candidatePatches` JSON is `[{itemId,patch:DocumentChange}]`;
  applying in array order produces the dashboard candidate. `items` contains approved buyer
  definitions; frozen template definitions remain the original semantic inputs.
- `contractDefinitions.previewBasis({...selectedArgs,itemId})` returns `{revision,
approvedChain:string,approvedChoice:ApplicationChoice|null}`. The chain JSON is newest-first.
  Root caches by version + stateVersion for immediate local exact variant changes.
- `buyerLinks.contentV2`, `sellerContent`, and `publicationV2` return one actual `document`,
  with no duplicate `blocks` field. Public overlays have mapped current targets and empty
  replacement arrays; explanations have mapped trigger targets. Native result capacity is
  checked. Buyer view is effective-only, so no extra baseline endpoint was added.
- `versionContext` now contains actual `document` and `approvedDocument`; candidate projection
  alone applies pending/rejected dashboard patches. `composedDiscussion` uses root's
  `ContractDocumentCompositionEngine` to retain immutable and replacement-origin anchors.
- `contractChanges` immutable metadata now requires `dataBytes` and `structuralBlocks` in
  `contractChangeValidators.ts`; no compatibility defaults. This supports budget preflight
  and metadata-only buyer footprint ancestry without loading entire approved patch history.
- Core fix: empty `prepareDocumentTransition` changes now transition to the reversed baseline
  (approved removals and legitimate no-op variants). Render validator omits old `pieceGroups`
  before replacing its type, avoiding an erroneous full/private lineage intersection.

### Validation and remaining integration

- Backend TypeScript: only two expected errors in obsolete `contractVersionMigration.ts`
  (missing required document IDs). Log `/tmp/contract-workflows-tsc.log`.
- Required existing performance suite was run twice: 33 passed, 6 failed on the old fixture/
  exact-write-count expectations being maintained by root. No assertions were weakened by
  this agent. Log `/tmp/contract-workflows-perf.log`; root must rerun after fixture completion.
- Full UI/lifecycle, production build, live Convex validation, actual browser interaction and
  capacity end-to-end behaviors remain unverified here. No deployment was authorized.
- Export handoff: `composeExport` root helper accepts `{document:ContractDocument}`. Read
  publication.approvedDocumentId directly using `readContractDocument`; do not replay effects.
  Remove obsolete migration + `writeVersionContent` and clean all five new storage tables.

## Export/cleanup integration (2026-11-11)

- `latestPublishedExport` reads the publication's scoped `approvedDocumentId` directly.
  Word and HubSpot quote actions receive its render transport and call
  `composeExport({document})`; selections/effect replay no longer reconstruct export wording.
- Word attempts and quote reservations pin `documentId`. Operation identity also captures
  the snapshot, quote payload/destination identity, and immutable delivery destination;
  membership, eligibility, current-publication/document and release guards run at each
  preparing/publishing/releasing boundary. Background quote admission/dispatch checks the
  pinned publication/document before provider creation.
- Contract cleanup drains intents/change payloads/changes/version state, then scans manifests
  one at a time. Referenced export evidence retains manifests; retained shared chunks are
  marked in batches of 20 before unretained chunks are swept. Company deletion drains
  export evidence first and erases all five new tables, including retained snapshot chunks.
- Deleted obsolete `contractVersionMigration`, `writeVersionContent`,
  `contractVersionContents`, version `contentChunks` and its migration marker. Unrelated
  baseline/HubSpot compatibility remains intact. No related script consumer remains.
- Production seed has a shared materialization helper. Offline reconciliation creates actual
  in-memory contracts and persists exact patches/intents/snapshots. Its unchanged independent
  archived-wording oracle checks actual snapshot effective output, accepted cumulative
  redlines, and effective-only exports. Server-rendered panel fixture uses resolved item data.
- Existing integration fixtures preserve ordered command expectations and rollback checks;
  the export snapshot assertion verifies pinned document identity and actual wording.

### Export validation checkpoint

- Backend TypeScript and tools TypeScript pass: `/tmp/contract-exports-tsc.log`,
  `/tmp/contract-exports-tools.log`.
- Existing mandatory performance suite: 39/39 pass (`/tmp/contract-exports-perf.log`).
- Existing HubSpot integration suite: 60/60 pass (`/tmp/contract-exports-hubspot.log`).
- Offline reconciliation passes all 24 scenarios with zero unexplained user-facing
  mismatches (`/tmp/contract-exports-seed.log`) after root repaired consumed empty
  placeholders and preserved untouched atoms during structural materialization. Dashboard
  actual output now crosses the same render transport as the client before composition;
  archived independent expectations remain unchanged. Tools TypeScript also passes after
  that fixture maintenance.
- Pure review identified one additional root-owned zero-placeholder edge case: replacing
  two adjacent empty atoms succeeds as a direct patch but its net transition collapses
  distinct source endpoints. Minimal repro: `/tmp/contract-zero-two-empty-placeholders.json`.
- No browser, new tests, deployment, environment mutation or database action performed.
  Actual provider delivery and large multi-batch snapshot retention remain unverified here.

### Dead state cleanup

- Removed unused `contractBuyerState` and `publicationAcknowledgments` tables, validator
  remnants, and contract/company deletion phases. Buyer projection accepts a small explicit
  publication metadata shape rather than deriving its DTO from deleted storage.
- Removed all unused `imported-contract-history` provenance fields from decision, approval
  request, discussion and buyer concession validators; no current writer or fixture uses them.
  Template and HubSpot compatibility fields remain outside this cleanup.
- Existing creation performance instrumentation now recognizes actual published version
  writes while preserving its zero-publication-write guarantee for draft creation.
- Backend and tools TypeScript pass; mandatory existing performance suite passes 39/39.
  Logs: `/tmp/contract-dead-state-tsc.log`, `/tmp/contract-dead-state-tools.log`,
  `/tmp/contract-dead-state-perf.log`. No deployment or database action performed.
