# Engineering Handoff & Audit Report: Playbook-Only End-State Refactor

> **Git Status Note:** **Zero git commits were created during this refactor.** All work is uncommitted in the working tree on top of `HEAD` (`ab2ff490ca7674653dea547f887ac001d0c4e770`, `"tweaks"`). Pass 1 touched **356 files (+6,550 / −33,190 LOC)**; Pass 2 added targeted architectural fixes and a client discussions rewrite (including −994 net LOC in `src/lib/discussions/session.svelte.ts` alone). This refactor assumes a **full database nuke/reset on cutover** — zero backwards compatibility was preserved.

---

## 1. Goal & Before/After Architecture

### Starting Prompt & Target End State
- **Starting problem:** Buyer-proposed changes (`type: 'proposal'` threads, buyer redlines, dual-lane `playbook` vs `buyer-link` reviews) forced materialized contract documents, immutable patch chains, multi-turn native staging pipelines, UTF-16 tape-splice discussion invalidation, B+ tree discussion unread/support indexes, output proof chunks, 90-day retention compaction, and heavy client recovery/pagination machinery across the entire app.
- **Target end state (Pass 1):** A contract is strictly:
  1. An immutable frozen `templateVersionId` (base `SourceBlock[]` + frozen `playbookItemRevisions` tagged by `audience: 'rep' | 'buyer'`), plus
  2. A flat `concessions[]` array and inline `review` object on `savedContracts`.
  Both seller (`/contracts/[id]`) and buyer (`/[token]`) views compose directly from frozen template blocks + applied Playbook concessions.
- **Post-audit hardening & simplification (Pass 2):** Root-cause audit of Pass 1 uncovered deadlocks on timeout + contract edit, approval cooldown bypasses, wrong CC reviewer attribution, single-anchor review tags on multi-change concessions, full-document WebSocket re-fetches on buyer-link updates, a thread-deletion race on >64-message threads, a 200-thread hard cliff, and dead client/schema baggage (`ProvisionalMessage`, `deleted: boolean`, `deletingFileId`, `buyerLinkActions.ts` Node action, 7-day vs 24-hour receipt TTL drift). All were fixed structurally.

### Before vs. After Architecture Comparison

| Subsystem | Before (`HEAD` `ab2ff490`) | After (Working Tree) |
| --- | --- | --- |
| **Schema tables** | **71 tables** | **51 tables** (**20 deleted**, `hubspotExports` → `wordExports`, 11 reshaped) |
| **Deleted tables (20)** | `contractDocuments`, `contractDocumentChunks`, `contractChanges`, `contractChangeHeads`, `contractChangeDecisions`, `contractChangeContents`, `contractOutputs`, `contractOutputChunks`, `approvalRequests`, `operationReceiptChunks`, `emailSelectionChunks`, `discussionReceipts`, `retentionSweeps`, `discussionInvalidations`, `discussionTransitionMapChunks`, `discussionUnreadNodes`, `discussionUnreadControls`, `discussionPassageIndexes`, `discussionPassageClaims`, `buyerLinkBrowseBackfills` | Removed from `src/convex/schema.ts` |
| **Contract state** | `savedContracts` pointed to `contractDocuments` + `contractChanges` / `Heads` / `Decisions` / `Contents` + `approvalRequests` + dual `reviews: { playbook, buyerLink }` | Single root `savedContracts` holds flat `concessions[]` (`{ itemId, optionId, status, reviewedBy?, reviewedAt? }`), single `review: { generation, request?, completion? }`, `stateRevision`, `lastOperation`, optional `quoteRequests` |
| **Template version manifest** | `templateVersions.items`: `{ itemId, revisionId }[]` (required hydrating up to 4,000 items to separate rep vs buyer items) | Added `audience: 'rep' \| 'buyer'` to `templateVersions.items[]`, enabling targeted `readItemsByIds()` & `readBuyerExplanations()` reads |
| **Contract saving** | Multi-turn staged `nativeConstruction*` / `nativeAuthority*` / `nativePlanPreparation*` + `contractChanges` lineage + `ActivityCommand` queue | Single-transaction `contracts.save` → `src/convex/contractSaving.ts`; zero-write no-op; reads blocks only if ≥2 selected options have edits |
| **Approvals & review UI** | Dual-lane `reviews.ts` + `contractApprovals.ts` + `contractCompletion.ts` + `approvalRequests` + `emailSelectionChunks` + `ContractReviewPages` + inline panel approve/withdraw/undo + `FocusedChangePreview` + buyer `?review=1` lane (`BuyerReviews`, `BuyerChangeActions`) | Single `src/convex/approvals.ts` (`decide`, `request`, `complete`); flat panel `Apply option` / `Remove option` toggle; admin decisions strictly in left-margin `src/lib/components/document/ReviewTags.svelte` (1 tag per distinct affected block); inline counts on `emailDeliveries.event` |
| **Buyer link sync & read path** | Manual `"Update buyer link"` / materialized `contractDocuments` / single monolithic `buyerLinks.currentDocument` re-pushing all blocks on every rename or approval | Permanent link created via V8 action `buyerLinks.ensureLatest`; `buyerLinks.currentView` **auto-syncs** on save/decision when 0 pending & 0 rejected, and on rename/buyer-name refresh. Split into tiny reactive `buyerLinks.currentState` + immutable one-time `buyerLinks.templateContent` (cached client-side by `templateVersionId`) + client-side `filterOverlappedExplanations` |
| **Discussions engine** | UTF-16 tape splices (`tape.ts`, `discussionTransitionMapChunks`), B+ tree unread/support trees (`discussionUnreadNodes`/`Controls`, `discussionSupportTree`), `discussionPassageIndexes`/`Claims`, tombstoned/invalidated zombie threads, `discussionReceipts`, `OperationStatus.svelte`, `recovery.svelte.ts`, `ProvisionalMessage.svelte`, `native-pagination.ts` (`onPaginatedUpdate_experimental`), `live-pages.svelte.ts`, `reply-state.svelte.ts` | Live-only `discussionThreads` (with `footprint` + `hasUnread` + `by_contractId_and_hasUnread`) and `discussionMessages` (no `deleted` boolean). Native Convex `.paginate()` on `discussions.list` & `discussions.replies`. Hard-delete on root delete or overlapping concession change via `src/convex/discussionInvalidation.ts`. Client `src/lib/discussions/session.svelte.ts` uses `PaginatedFeed` + single `activeComposer` union |
| **Word export & HubSpot Quotes** | 6-step `reserve` → `content` → `publish` → `acknowledge` + `contractOutputs`/`Chunks` + `outputProof*` + 90-day retention compaction + `localStorage` `download-journal.ts` | 2-step `prepare` → Node action generate & `ctx.storage.store` → `commit` on `wordExports` and `hubspotQuotePushes`. No browser ack journal, no `outputProof*`, no `deletingFileId` |
| **Operation receipts** | Split `operationReceipts` + `operationReceiptChunks` + `discussionReceipts` + `operationExpiry` + `accountOperationCleanup` + `OPERATION_EXPIRED`/`OPERATION_FUTURE` | Single flat `operationReceipts` table (24h TTL, daily cron `operationReceipts.pruneExpired`, preserved across single-contract delete, wiped on company delete) + existing `contractCreationReceipts` (also 24h TTL) |
| **Crons & recovery** | Included `retentionMaintenance`, `operationExpiry`, `discussionMaintenance`, `emailDisposal`, `nativeConstructionCleanup`, `outputProofCleanup` | `src/convex/crons.ts` runs `operationReceipts.pruneExpired` (03:30 daily) & `contractExports.expire` (5m) plus unchanged CSM, HubSpot, Clerk, buyer activity, template upload, and `storageOwnership.cleanOrphanFiles` crons. `src/convex/recovery.ts` probes only `deletedUsers`, `companyDeletions`, `contractCleanups`, `buyerLinkShowingCleanups`, `emailDeliveries` |
| **Client caches & drafts** | IDB v16 with `snapshots`, `metadata`, **`approved`** store; `dinu:drafts:v6` with command-sourced queue, `blockedOriginals`, `memoryOnly`, `recoveryBlocked` | IDB **v17** (`snapshots` + `metadata` only; drops `approved` store on upgrade), `dinu:drafts:v7` envelope **v1** (`{ version: 1, baseStateRevision, selections, request, conflict }`). *(Note: `browser-storage.ts` still uses `dinu:v8` while docs claim `dinu:v9` — see §5.)* |

### Prior Assumptions & Commits Built On / Superseded
- Built on `9b84c57` (`seems good`, which added `audience` to `data/convex/playbookItems.jsonl`), `835901b` (`stuff`, which added `run.discussion` coordinates to `compose.ts`), and `27dfb0c` (`changes`, which moved `src/lib/contract/compose.ts` → `src/lib/document/compose.ts` and changed `patchAnnotation` so multi-change secondary targets inherit their parent trigger via `annotation.origin`).
- Superseded `data/reference/compositor.json` last frozen at `9b6e581` (`hubspot integration`) — refreshed across all 48 states after confirming `seed:reconcile` had 0 user-facing mismatches.
- Superseded every preservation/cutover assumption for materialized documents, native staging, download acknowledgment journals, buyer proposals, and raw/compacted output proofs.

---

## 2. Complete File & Symbol Inventory

### Git Commits
- **Base commit:** `ab2ff490ca7674653dea547f887ac001d0c4e770` (`tweaks`).
- **Commits created during this refactor:** **None** (all changes are uncommitted in the working tree).

### A. `src/convex/`

#### Deleted (`66` files)
- **Proposals (5):** `discussionProposals.ts`, `proposalSource.ts`, `buyerSupportEligibility.ts`, `discussionClaims.ts`, `discussionSupportTree.ts`
- **Materialized docs & change lineage (11):** `contractDocuments.ts`, `contractChanges.ts`, `contractChangeHeads.ts`, `contractChangeValidators.ts`, `contractAuthority.ts`, `contractAnnotations.ts`, `contractDefinitions.ts`, `contractDocumentLifetime.ts`, `buyerProjection.ts`, `buyerCurrent.ts`, `reviewDetails.ts`
- **Native staging & email chunking/disposal (14):** `nativeConstruction.ts`, `nativeConstructionAction.ts`, `nativeConstructionCleanup.ts`, `nativeConstructionStorage.ts`, `nativeAuthority.ts`, `nativeAuthorityAction.ts`, `nativePlanPreparation.ts`, `nativePlanPreparationAction.ts`, `nativeStage.ts`, `nativeStageValidators.ts`, `nativeEmail.ts`, `nativeEmailValidators.ts`, `emailSelectionChunks.ts`, `emailDisposal.ts`
- **Output proofs, 90-day retention & operation expiry (10):** `outputLifecycle.ts`, `outputProof.ts`, `outputProofCleanup.ts`, `outputReservations.ts`, `outputValidators.ts`, `contractRetention.ts`, `retentionMaintenance.ts`, `retentionValidators.ts`, `operationExpiry.ts`, `accountOperationCleanup.ts`
- **Tape-splice & B+ tree discussions (15):** `discussionPassage.ts`, `discussionPassageAction.ts`, `discussionPassageIndex.ts`, `discussionOperations.ts`, `discussionOperationReferences.ts`, `discussionExecution.ts`, `discussionMaps.ts`, `discussionTransitions.ts`, `discussionIndex.ts`, `discussionIndexValidators.ts`, `discussionTree.ts`, `discussionUnreadTree.ts`, `discussionMaintenance.ts`, `discussionPreparation.ts`, `discussionPreparationValidators.ts`
- **Consolidated/redundant shims & Node wrapper (11):** `hubspotExports.ts`, `contractDisplay.ts`, `contractReviewIdentity.ts`, `contractReader.ts`, `contractSource.ts`, `contractSourceValidators.ts`, `documentExport.ts`, `exportRetention.ts`, `contractCompletion.ts`, `reviews.ts`, `contractApprovals.ts`, and (in Pass 2) `buyerLinkActions.ts`

#### Created (`2` files)
- `src/convex/approvals.ts` — Unified Playbook approval mutations: `decide`, `request`, `complete`.
- `src/convex/discussionInvalidation.ts` — Structural footprint comment hard-deletion & O(1) unread sync: `refreshDirectoryUnread`, `deleteThreadAndMessages`, `drainThreadMessages`, `deleteAffectedComments`, `continueDeleteAffected`.

#### Modified
- `src/convex/schema.ts` — 71 → 51 tables; renamed `hubspotExports` → `wordExports`; added `audience` on `templateVersions.items`; flattened `operationReceipts`, `savedContracts`, `buyerLinks`, `discussionThreads` (`by_contractId_and_hasUnread`), `discussionMessages`, `emailDeliveries` (dropped `by_snapshot_receiptId`, `by_disposal_generation`).
- `src/convex/_generated/api.d.ts` — Updated module registry (removed deleted modules including `buyerLinkActions`, added `approvals`, `discussionInvalidation`). *(Note: manually updated without running live `npx convex dev`.)*
- `src/convex/contracts.ts` — Rewrote `stateOf`, `metadataOf`, `deliveryStatusOf`, `state`, `create`, `save` (replaced `saveChanges`), `rename`, `remove`, `createContract`. Dropped `operationResult`, materialized doc creation, `approvalRequests` lookup.
- `src/convex/contractSaving.ts` — Replaced staged native save with single-transaction `saveSelections` (optimistic `expectedStateRevision`, `operationReceipts`, zero-write no-op, targeted `readItemsByIds`, conditional block read for `activeConflicts`, admin auto-approval, `removeDelivery` on `reviewChanged`, HubSpot `'applied'` events, auto `syncBuyerLink`).
- `src/convex/contractState.ts` — Simplified `patchContract` (calls `syncBuyerLinkMetadata` on `title`/`buyer` changes, updates `contractDirectory`).
- `src/convex/contractDirectory.ts` — Removed `buyerLinkBrowseBackfills`; kept `writeDirectory`, `writeDirectoryUnread`, `markDirectoryBuyerLinkPublished`, `removeDirectoryEntry`, `readDirectory`.
- `src/convex/contractValidators.ts` — Rewrote `storedContract` (flat `concessions`, `review`, `stateRevision`, `lastOperation`, optional `quoteRequests`), added `requestDeliveryStatus`, removed `storedApprovalRequest`, `approvalRequest`, `documentId`/`documentRevision`, dual `contractReviews`.
- `src/convex/savedContractValidators.ts` — Rewrote `contractState`, `contractMetadata`, `liveContractMetadata` (includes `requestDelivery`), `wordExportResult`, `saveResult` (`saved | conflict | deleted`).
- `src/convex/templates.ts` — Populated `audience` on `templateVersions.items`; added `readItemsByIds` and `readBuyerExplanations` on `versionReader`/`snapshotReader`; updated `orderedHeads`/`orderedAudienceHeads` to check `reference.audience`.
- `src/convex/playbookItems.ts`, `src/convex/operator.ts`, `src/convex/authoringMigration.ts` — Propagated `audience` into `templateVersions.items` writes.
- `src/convex/buyerLinks.ts` — Added `displayIdentityFor`, `syncBuyerLink`, `syncBuyerLinkMetadata`, `hasSingleActiveOwnLink`, V8 `action` `ensureLatest` (moved from `buyerLinkActions.ts` using `crypto.getRandomValues`), split `currentDocument` → `currentState` + `templateContent`; updated `capture`, `sellerContext`, `dashboardPresence`, `browse`, `authorizeDownload`.
- `src/convex/buyerValidators.ts` — Replaced `buyerDocument` with `buyerCurrentView`, `buyerLink`, `buyerExplanation`, `appliedOverlay`, `buyerTemplateContent`, `buyerDocumentState`, `linkSummary`, `linkCapture`, `publicStatus`.
- `src/convex/buyerLinkPresentation.ts` — `claimFirstBuyerLinkHintShowing` now uses `hasSingleActiveOwnLink` (skips revoked `currentView: null` rows).
- `src/convex/discussions.ts` — Replaced 6 query endpoints with native `.paginate()` `list` and `replies`, plus `viewer`, `markSeen`, `write`, `buyerWrite`, `buyerViewer`.
- `src/convex/discussionCommands.ts` — Synchronous `writeDiscussion` (`create`/`reply`/`edit`/`delete`) & `markDiscussionSeen` using `composeDocument` + `anchorPassage` + `extractFootprint`, hard-delete via `deleteThreadAndMessages`, unified `operationReceipts`, O(1) `refreshDirectoryUnread`. Removed `deleted` flag and proposal handling.
- `src/convex/discussionContext.ts` — Simplified `discussionContext` & `ownsDiscussion` (no proposal/support fields).
- `src/convex/discussionService.ts` — Simplified `discussionActor`, `authorView`, `messageProjector` (removed `deleted` field).
- `src/convex/discussionValidators.ts` — Stripped `storedReceipt`, tombstones, tape offsets, `type`, `deleted`; added `footprint` & `hasUnread` on `storedThread`.
- `src/convex/operationReceipts.ts`, `src/convex/operationReceiptValidators.ts` — Flattened receipt storage; set `RECEIPT_TTL_MS = 24 * 60 * 60 * 1000`; added `pruneExpired` cron mutation (prunes both `operationReceipts` and `contractCreationReceipts`); removed `operationReceiptChunks` & timestamp-encoded operation IDs.
- `src/convex/contractExports.ts`, `src/convex/wordExport.ts`, `src/convex/wordExportGeneration.ts`, `src/convex/exportValidators.ts` — Collapsed to `prepare` / `commit` / `expire` / `cleanupCompanyExports` on `wordExports`; removed `deletingFileId`; separated `downloadExpiresAt = createdAt + EXPORT_TTL_MS` (1h) from physical `expiresAt` (1h+15m or 30d+15m).
- `src/convex/hubspotExportDeliveries.ts`, `src/convex/hubspotExportDeliveryValidators.ts` — Retargeted `attemptId` to `v.id('wordExports')`; added `recordExportDelivery`, `confirmUpload`, `retireExportDelivery`.
- `src/convex/hubspotQuotes.ts`, `src/convex/hubspotQuoteActions.ts`, `src/convex/hubspotQuoteRecovery.ts`, `src/convex/hubspotQuoteValidators.ts` — 2-step `prepare` → `composeExport`/`exportHtml`/`storage.store` → `commit`; removed `outputId`/`documentId`/`format`/`deletingFileId`; kept canonical dedup, `equivalentTerms` verify, operator recovery, and 30d payload/diagnostic expiry.
- `src/convex/hubspotDelivery.ts`, `src/convex/hubspotSender.ts`, `src/convex/hubspotRecords.ts`, `src/convex/hubspotValidators.ts`, `src/convex/hubspotCleanup.ts`, `src/convex/hubspotUninstall.ts`, `src/convex/hubspotRecipients.ts`, `src/convex/hubspotDeals.ts` — Updated `wordExports` refs, removed `deletingFileId`, wired `syncBuyerLinkMetadata` in `hubspotRecipients.commit`.
- `src/convex/emailDeliveries.ts`, `src/convex/emailValidators.ts`, `src/convex/emailNotifications.ts`, `src/convex/contractEmail.ts`, `src/convex/emailSender.ts` — Dropped `snapshot`, `filter`, `disposal`, `emailSelectionChunks`, `buyer-link` URLs; added `removeDelivery`; inlined counts on `approvalEmailEvent` / `decisionEmailEvent`.
- `src/convex/contractCleanup.ts`, `src/convex/contractCleanupValidators.ts`, `src/convex/companyDeletion.ts`, `src/convex/deletionValidators.ts`, `src/convex/accountDeletion.ts`, `src/convex/storageOwnership.ts`, `src/convex/crons.ts`, `src/convex/recovery.ts`, `src/convex/http.ts` — Removed all deleted table/phase/cron/route references (`fileOwned` updated to `wordExports`; `http.ts` `/buyer/discussions` dropped `'result'` variant and `OPERATION_EXPIRED`).

### B. `src/lib/`

#### Deleted (`26` files)
- **Document/preview (5):** `src/lib/document/contract-document.ts`, `src/lib/document/contract-document-validators.ts`, `src/lib/document/contract-compose.ts`, `src/lib/document/panel-source-facts.ts`, `src/lib/contract/document-preview.ts`
- **Contract staging/command/journal (10):** `src/lib/contract/items.ts`, `src/lib/contract/item-identity.ts`, `src/lib/contract/activity-commands.ts`, `src/lib/contract/operation-identity.ts`, `src/lib/contract/operation-recovery.ts`, `src/lib/contract/operation-result.ts`, `src/lib/contract/output-action.ts`, `src/lib/contract/review-pages.svelte.ts`, `src/lib/contract/download-journal.ts`, `src/lib/contract/prepare-action.ts`
- **Discussions tape/recovery/pagination/provisional (8):** `src/lib/discussions/tape.ts`, `src/lib/discussions/passage-index.ts`, `src/lib/discussions/OperationStatus.svelte`, `src/lib/discussions/recovery.svelte.ts`, `src/lib/discussions/reply-state.svelte.ts`, `src/lib/discussions/live-pages.svelte.ts`, (Pass 2) `src/lib/discussions/ProvisionalMessage.svelte`, plus `src/lib/native-pagination.ts`
- **Buyer proposals & preview UI (3):** `src/lib/buyer/BuyerChangeActions.svelte`, `src/lib/buyer/reviews.svelte.ts`, `src/lib/components/playbook/FocusedChangePreview.svelte`

#### Created (`1` file)
- `src/lib/contract/idempotent-action.svelte.ts` — Shared `IdempotentAction<Args, Result>` controller retaining `{ args, uncertain }` on timeouts/network errors while unconditionally clearing pending identity on definite `ConvexError`.

#### Modified
- **Document & Playbook core:**
  - `src/lib/document/compose.ts` — Dropped `change.suppressed`, `discussionRemoved`; added `paragraph.annotation.discussionOffset ?? 0` to `generatedContent` cache key (`generated-discussion-v3`); cleaned comments.
  - `src/lib/document/source-index.ts`, `src/lib/document/model.ts`, `src/lib/document/compiled-document.ts`, `src/lib/document/domain/document-domain.ts`, `src/lib/document/panel-anchor.ts`, `src/lib/document/annotation-projection.ts`, `src/lib/document/pagination/prepare.ts`, `src/lib/document/pagination/tokenize.ts`, `src/lib/document/pagination/types.ts`, `src/lib/document/highlights/theme.ts`, `src/lib/styles/document.css` — Removed materialized document modes, `sourceOrigin`, `discussionRemoved`, `discussion-proposal` styles.
  - `src/lib/document/runtime/artifacts.ts`, `renderer.svelte.ts`, `source.svelte.ts`, `workspace-factory.ts`, `types.ts`, `resources.svelte.ts` — Removed materialized source kind, made `onRemoveConcession` optional on `ViewerBindings`.
  - `src/lib/document/export/content.ts` — `composeExport` now drains `DocumentCompositionEngine.compose` directly from `{ blocks, items, concessions }` and reads `engine.numberingBlocks` / `engine.addresses`.
  - `src/lib/document/review-anchors.ts` — `ReviewAnchorProjector` projects 1 tag per distinct blockKey per `ReviewTag.targets` (`key: itemId`, `itemId:1`, …).
  - `src/lib/playbook/document-overlay.ts` — Removed `passive`, `origin.kind === 'proposal'`, `suppressed`; added `filterOverlappedExplanations`.
  - `src/lib/playbook/model.ts`, `selection-conflicts.ts`, `structure.ts` — Dropped `ContractItemRecord` / proposal types.
- **Contract client layer (`src/lib/contract/`):**
  - `changes.ts` — Flat `concessionStatus`, `contractConcession`, `contractReview`, `contractReviewCompletion` (with `decidedAt: v.number()`), `concessionSelectionMap`, `approvedConcessionMap`, `contractReadiness`.
  - `approval.ts` — `ReviewTag` with `targets: readonly SourceTarget[]`, `availableReviewDecisions(status)`, `deriveReviewTags`.
  - `saved.ts` — Added `persistedContractMetadata` helper, simplified `olderContractState(next, current)` to `next.stateRevision < current.stateRevision`.
  - `persisted-values.ts`, `draft-values.ts`, `draft-recovery.svelte.ts` — Validated `concessions[]` + `review` (incl. `decidedAt`), `dinu:drafts:v7` envelope `version: 1`.
  - `snapshot-storage.ts`, `snapshot-cache.ts` — Bumped IDB to v17, dropped `approved` store & flights, reused `persistedContractMetadata`.
  - `persistence.svelte.ts` — Rewrote for flat `selections` saving; clears `this.request` on any `ConvexError` (including `workBlock`).
  - `editors.svelte.ts` — Rewrote around `contracts.state`, `contracts.save`, `persistedContractMetadata`, removed download/recovery/review-page coupling.
  - `review-controller.svelte.ts` — Rewrote for `approvals.{decide,request,complete}`, added `completionKey` (`${generation}:${decidedAt}`), stale attempt pruning in `reconcile()`.
- **Discussions client (`src/lib/discussions/`):**
  - `validators.ts`, `anchors.ts`, `dom-anchor.ts`, `limits.ts`, `transport.ts` — Added `concession` point, `discussionFootprint`, `extractFootprint`, `buildConcessionChangeSet`, `footprintAffectedByChanges`, `matchesQuoteWithReferences`; removed `type`, `deleted`, `allowEmpty`, `'result'`.
  - `session.svelte.ts` — Rewritten twice (1,933 → 1,352 → 939 lines): `PaginatedFeed` (up to 20×200 pages with ID dedup), single `activeComposer` union, `deletingMessageId`, removed `ProvisionalMessage`/provisional maps/`deletedThreads`/`recognizeSeller`/`synchronizePolicy`.
  - `DiscussionLayer.svelte`, `DiscussionThread.svelte`, `DiscussionRootCard.svelte`, `DiscussionMessage.svelte`, `MessageComposer.svelte`, `ReplyComposer.svelte` — Removed proposals, `OperationStatus`, `ProvisionalMessage`, `deleted` checks.
- **Buyer & Workspace components:**
  - `src/lib/buyer/contract.svelte.ts` — Replaced single `currentDocument` subscription with `currentState` subscription + cached immutable `templateContent` (`templates` + `templateReads` maps, `latestStateSeq` ordering guard).
  - `src/lib/buyer/BuyerDocument.svelte` — Client-side `filterOverlappedExplanations`, skips `workspace.accept` on title-only renames, dropped dummy `onRemoveConcession`.
  - `src/lib/buyer/BuyerDiscussions.svelte` — Stripped redundant `synchronizePolicy` and `recognizeSeller` `$effect`s; passes `discussionReadOnly` directly into session creation effect.
  - `src/lib/buyer/links.svelte.ts` — Migrated `BuyerLinkController` onto `IdempotentAction({ cacheResult: true })` calling `api.buyerLinks.ensureLatest`.
  - `src/lib/buyer/BuyerDocumentFrame.svelte`, `BuyerShell.svelte`, `BuyerContractPage.svelte`, `seller.svelte.ts`, `CopyBuyerLink.svelte` — Removed proposal review UI, `"Update buyer link"`, `?review=1`, `BuyerSeller.perform()`.
  - `src/lib/components/workspace/RepWorkspace.svelte`, `SavedDocumentFrame.svelte`, `SavedContract.svelte`, `CreationContractPreview.svelte` — Migrated `pushQuote` and `downloadSavedWord` to `IdempotentAction`; keyed `ReviewCompletedModal` by `${contractId}:${generation}:${decidedAt}`; removed `download-journal`, `ContractReviewPages`, `exportStatus` query, dummy `onRemoveConcession`.
  - `src/lib/components/playbook/RepPlaybookPanel.svelte`, `src/lib/components/document/ReviewTags.svelte`, `review-tag-copy.ts`, `src/lib/components/ui/modal/ReviewCompletedModal.svelte`, `help-content.ts`, `src/lib/components/document/DocumentViewer.svelte`, `RetainedViewer.svelte`, `DocumentPage.svelte`, `SourceText.svelte`, `BlockFragment.svelte` — Flat toggle UI, multi-anchor `ReviewTags` with `availableReviewDecisions`, optional `onRemoveConcession`, emitted `data-discussion-origin`/`offset`/`atomic` attributes.

### C. `src/routes/`
- `src/routes/api/buyer/[token]/download/+server.ts` — Calls `api.buyerLinks.currentState`, checks `displayIdentity` before fetching `api.buyerLinks.templateContent`, composes via `composeExport`, then re-verifies with a fresh `ConvexHttpClient` calling `api.buyerLinks.authorizeDownload`.
- `src/routes/api/buyer/discussions/+server.ts` — Dropped `'result'` lookup path; kept origin check, HttpOnly `dinu_discussion_browser` cookie minting, Clerk bearer/cookie auth forwarding, and `BUYER_LINK_INGEST_SECRET` proxy to `/buyer/discussions`.
- `src/routes/(buyer)/[token=buyerCode]/+page.svelte` & buyer layout/route files — Removed `?review=1` buyer-link review lane routing.

### D. `scripts/` & `data/`
- **Modified scripts:** `scripts/reconcile-production-seed.mjs` (updated `RepPlaybookPanel` props for `RepInstructionRecord` + `onToggle`), `scripts/production-seed.mjs`, `scripts/seed-convex.mjs`, `scripts/verify-loading-bundles.mjs` (kept clean boundaries without deleted modules).
- **Modified data:** `data/reference/compositor.json` — Refreshed all 48 frozen compositor states (`sha256` + `provenanceSha256`) gated by 0 `seed:reconcile` mismatches.

### E. `tests/`
- **Deleted (3 files):**
  - `tests/components/viewer/BuyerChangeActionsHarness.svelte`
  - `tests/components/viewer/materialized-composition-snappiness.test.ts`
  - `tests/client/downloads/download-journal.test.ts`
- **Modified:**
  - `tests/support/linked-contract.ts`, `tests/support/document.ts`, `tests/support/contract-data.ts`
  - `tests/backend/contracts/saving.test.ts`, `creation.test.ts`
  - `tests/backend/exports/exports.test.ts`, `word-actions.test.ts`, `buyer-download.test.ts`, `word-generation.test.ts`
  - `tests/backend/hubspot/activity.test.ts`, `delivery.test.ts`, `quotes.test.ts`, `uninstall.test.ts`, `security.test.ts`, `refresh.test.ts`
  - `tests/client/caching.test.ts`
  - `tests/components/contracts/fixtures.ts`, `buyer-links.test.ts`
  - `tests/components/downloads/seller-download.test.ts`, `download-state.svelte.ts`
  - `tests/components/loading/loading-recovery.test.ts`
  - `tests/components/viewer/buyer-discussion-regressions.test.ts`, `tools-help-snappiness.test.ts`
  - `tests/components/home/home-snappiness.test.ts`

### F. `docs/`
- **Deleted:** `docs/backend-preservation-cutover.md`, `docs/discussion-post-performance.md` (obsolete migration/proposal-staging docs).
- **Modified:** `docs/data-model.md`, `docs/lifecycle.md`, `docs/retention.md`, `docs/email-delivery.md`, `docs/hubspot.md`, `docs/document-formatting.md`, `docs/rendering-snappiness.md`, `docs/performance-checks.md`, `docs/account-routes.md`, `docs/company-deletion.md`. *(Several stale sentences survived — see §5.)*

---

## 3. Intentional Design Decisions & Non-Obvious Invariants ("Why It Is This Way")

### Convex Platform & Transaction Constraints
1. **Single `.paginate()` per mutation:** In `src/convex/contractCleanup.ts` (L213–L215), finishing the `exports` phase explicitly schedules `hubspotQuotes` via `schedule(ctx, marker, 'hubspotQuotes', 0, undefined)` and returns instead of falling through, because Convex rejects two `.paginate()` calls in one mutation transaction.
2. **Targeted template reads (`audience` on `templateVersions.items`):** Templates can have up to `MAX_PLAYBOOK_ITEMS` items, and hydrating all `playbookItemRevisions` on every buyer load or contract save would blow Convex's 16 MiB / 4,096 query limits. Tagging each manifest entry with `audience: 'rep' | 'buyer'` lets `buyerLinks.templateContent` read only buyer explanations and `buyerLinks.currentState` / `contractSaving` / `contractExports` / `hubspotQuotes` read only the few applied/selected item IDs via `readItemsByIds()`.
3. **Conditional block read in `contracts.save`:** `src/convex/contractSaving.ts` (L90–L101) skips loading `templateSourceChunks` and building `SourceIndex` unless ≥2 selected options actually carry document `changes`. This preserves the `saving.test.ts` perf guarantee (0 block reads for 0/1 edits or explanation-only options).
4. **15 MiB response cap on `buyerLinks.templateContent`:** `src/convex/buyerLinks.ts` (L533–L534) checks `getConvexSize(result) > 15_000_000` (headroom below Convex's 16 MiB query return limit).
5. **Bounded `deleteAffectedComments` + thread-first deletion:** `src/convex/discussionInvalidation.ts` (L60–L72) deletes the `discussionThreads` row **first** synchronously (so live queries and `refreshDirectoryUnread` see it disappear atomically in the same transaction) and then drains up to 64 `discussionMessages`, scheduling `drainThreadMessages` only if >64 messages exist. It caps synchronous thread scanning at `SYNC_THREAD_LIMIT = 64` and passes `maxContentRevision` to `continueDeleteAffected` so newly posted comments on the new `contentRevision` are never deleted by a lagging async worker.
6. **Pure deterministic `prepare` query vs. action clock check:** `src/convex/contractExports.ts` (L66–L71) intentionally avoids `Date.now()` in `prepare` (returning `downloadExpiresAt: prior.createdAt + EXPORT_TTL_MS`), and `src/convex/wordExportGeneration.ts` (L18–L19) checks `prepared.downloadExpiresAt <= Date.now()` in the action. `commit` re-checks `prior.createdAt + EXPORT_TTL_MS <= Date.now()` authoritatively inside the mutation.

### Why Certain Awkward-Looking Structures Were Kept On Purpose
- **`savedContracts.lastOperation` alongside `operationReceipts`:** Looks redundant at first glance, but `ContractPersistence.accept()` (`src/lib/contract/persistence.svelte.ts:182-188`) reconciles lost save mutation responses passively via the live `contracts.state` subscription by comparing `next.lastOperationId === this.request.operationId`. Removing `lastOperation` would require a dedicated receipt lookup query on every reconnect.
- **`contractCreationReceipts` separate from `operationReceipts`:** Kept separate because `contracts.create` returns `{ status: 'deleted' }` if a created contract was later deleted and the original create request replays (storing `contractId` cleanly without serializing a full `contractMetadata` snapshot in `result`), whereas `operationReceipts` returns cached JSON results. Both now share `RECEIPT_TTL_MS` (24h) and are pruned together in `operationReceipts.pruneExpired`.
- **`operationReceipts.contractId` has no index and is NOT deleted by `contractCleanup`:** Intentional. Deleting receipts on single-contract delete would break replay fences for in-flight retries (`create`, `save`, `quote`). Rows expire after 24h via `by_expiresAt` and are wiped on `companyDeletion` via `by_companyId`.
- **`hubspotQuotes.commit` 2-pass (`payload-required`) flow:** `src/convex/hubspotQuoteActions.ts` (L58–L72) calls `commit` *without* `fileId` first to check `canonicalKey` deduplication before uploading HTML to `_storage`, then uploads and calls `commit` with `fileId`, and unconditionally runs `discardFile` in `finally`. This avoids storing duplicate `_storage` blobs on deduplicated pushes and prevents leaked blobs if `commit` throws or times out after storage upload (`discardFile` calls `deleteUnownedFile`, which checks all 5 owner tables transactionally before deleting, so adopted blobs survive).
- **`removeDelivery` refusing to delete during `providerDispatchInProgress`:** `src/convex/emailDeliveries.ts` (L49–L61) leaves an in-flight `emailDeliveries` row intact if an action has already crossed `beginDispatch` into Loops, because deleting the row would crash the action's `finish` mutation and destroy dispatch evidence.
- **Separate `wordExports` download TTL vs. physical `expiresAt`:** Unlinked local downloads stay retry-eligible for 1h (`createdAt + EXPORT_TTL_MS`) while bytes physically survive for 1h + 15m (`EXPORT_READ_GRACE_MS`) so an in-progress browser fetch started at minute 59 doesn't 404. HubSpot-linked exports extend physical `expiresAt` to 30d + 15m while keeping local retry eligibility at 1h; `confirmUpload` shortens `expiresAt` back to `max(createdAt + 1h, now) + 15m`.
- **`BuyerDiscussions` / `session.svelte.ts` Clerk-cookie refresh & `coordinateDiscussionViewer`:** Looks heavy on a public buyer page, but a buyer might have a stale Clerk `__session` cookie from another Dinu workspace; `/api/buyer/discussions` returns 401 when `__session` is present without a valid JWT so a seller doesn't accidentally post anonymously as `"Buyer"` when their token expired. `coordinateDiscussionViewer` prevents parallel tabs from racing `dinu_discussion_browser` cookie minting.
- **Buyer download 2-client verification:** `src/routes/api/buyer/[token]/download/+server.ts` (L53–L57) instantiates a **second** `ConvexHttpClient` after `.docx` generation to call `buyerLinks.authorizeDownload`, preventing a pinned read timestamp from authorizing bytes for a contract changed/revoked during generation.
- **`DocumentCompositionEngine` `generated-discussion-v3` & `dom-anchor.ts` `matchesQuoteWithReferences`:** `compose.ts` tracks logical `discussionOffset` (where cross-reference atoms count as length 1, not rendered string length) so a Page 1 concession that renumbers `"Section 5"` → `"Section 6"` neither shifts comment offsets nor invalidates comments on unaffected clauses.

---

## 4. Exact Behavioral & Data-Flow Semantics Changed

### A. Contract Saving & Approval State Machine
1. **Saving (`src/convex/contractSaving.ts`):**
   - Replay check (`operationReceipts` via `actionKey(access, 'save', operationId)`) runs **before** `requireContractWork` and `expectedStateRevision` checks. Mismatched `inputs` throws `ConvexError`.
   - Stale `expectedStateRevision` returns `{ status: 'conflict', state }` (does not throw).
   - Unchanged `selections` returns `{ status: 'saved', state }` with 0 item reads, 0 block reads, 0 DB writes, and 0 receipt writes.
   - Option status assignment on change:
     - `approvalPolicy.kind === 'none'` → `'approved'`
     - Same `(itemId, optionId)` already present → preserves existing `{ status, reviewedBy, reviewedAt }`
     - Caller is `admin` → `'approved'` (no separate HubSpot `'approved'` note; only `'applied'` note)
     - Caller is `rep` → `'pending'`
   - `reviewChanged` triggers when any non-approved concession is removed OR the sorted `[itemId, optionId, status]` signature of `approvalPolicy.kind === 'required'` items changes. When `reviewChanged`: increments `review.generation`, clears `review.request` and `review.completion`, and calls `removeDelivery()` on any previous request/completion `emailDeliveries` rows.
   - Patches `savedContracts` (`stateRevision + 1`, `savedAt`, `lastOperation`), updates `contractDirectory`, and **if `contractReadiness(nextConcessions).ready` (0 pending & 0 rejected)** calls `syncBuyerLink(ctx, updated.root)`.
2. **Admin Review (`approvals.decide`, `approvals.request`, `approvals.complete` — `src/convex/approvals.ts`):**
   - `decide`: Requires `role === 'admin'`, `expectedStateRevision`, matching `(itemId, expectedOptionId)`, and forbids no-op same-status transitions (`pending → approved|rejected`, `approved → rejected`, `rejected → approved`). If changing after completion was already `queued`, calls `removeDelivery()` on the old decision delivery. Whenever `!hasPending && hasRequired`, writes `review.completion = { generation, kind: 'awaitingConfirmation', reviewerId: access.profile._id, decidedAt: now }`. Increments `stateRevision`. Calls `syncBuyerLink` **only if** `contractReadiness(nextConcessions).ready` (so switching `approved → rejected` leaves `buyerLinks.currentView` on the previous approved concessions until the rep removes the declined concession).
   - `request`: Requires `expectedGeneration === review.generation` and company `approvalEmail`. Inspects existing same-generation `review.request`:
     - `'sending'` / `'sent'` → records receipt and returns current status (no duplicate email/activity).
     - `'uncertain'` with `!retryEligible` → throws `ConvexError` (enforces 10-minute `UNCERTAIN_COOLDOWN`).
     - `retryEligible` (`'failed'` or post-cooldown `'uncertain'`) → calls `restartDelivery()` reusing the existing `emailDeliveries` row without emitting a second HubSpot `'requested'` event.
     - `'skipped'` or missing delivery → removes stale delivery if present, logs HubSpot `'requested'` event, inserts new `emailDeliveries` row, patches `review.request` (does **not** bump `stateRevision`).
   - `complete`: Requires `role === 'admin'`, checks `expectedGeneration` + `completion.kind === 'awaitingConfirmation'` + 0 pending concessions (returns `{ status: 'skipped' }` if stale; `{ status: 'queued' }` if already queued). Queues Loops decision email with `reviewerId: completion.reviewerId` (triggering reviewer, not necessarily the confirming admin) and patches `review.completion = { generation, kind: 'queued', deliveryId }` (does **not** bump `stateRevision`).

### B. Buyer Link Auto-Sync, Split Reads & Comment Invalidation
- **Auto-sync (`syncBuyerLink` / `syncBuyerLinkMetadata` in `src/convex/buyerLinks.ts`):**
  - `displayIdentity = sha256(JSON.stringify([templateVersionId, title, sortedConcessions]))`.
  - When `concessions` change on a ready contract: increments `currentView.contentRevision`, updates `concessions`/`title`/`buyerName`/`displayIdentity`, and calls `deleteAffectedComments(ctx, root, prevConcessions, nextConcessions, prevView.contentRevision)`.
  - Title-only / buyerName-only changes update `currentView` without incrementing `contentRevision` or invalidating comments.
- **Buyer read split (`src/lib/buyer/contract.svelte.ts`, `src/lib/buyer/BuyerDocument.svelte`):**
  - Live subscription on `buyerLinks.currentState` returns `{ templateVersionId, title, contentRevision, displayIdentity, concessions, appliedOverlays }` (zero `blocks`).
  - `templateContent` is fetched once per `templateVersionId` via `queryOnce` and cached in `BuyerContract.templates`. Subsequent `currentState` pushes keep the exact same `blocks` array reference so `DocumentDomain.acceptBlocks()` short-circuits in O(1).
  - `BuyerDocument.svelte` tracks `acceptedBlocks`, `acceptedOverlaysKey`, `acceptedConcessionsKey` so title-only renames skip `workspace.accept()` completely, and filters `content.rawExplanations` client-side via `filterOverlappedExplanations`.
- **Comment creation & hard-delete invalidation:**
  - `writeDiscussion` (`create`) rejects if `command.contentRevision !== view.contentRevision`, composes the effective document via `composeDocument`, verifies `anchorPassage(resolved, command.anchor, true)` (exact quote match), extracts `footprint = { templateStart?, templateEnd?, blockKeys[], concessions[] }`, inserts thread + root message, and updates `contractDirectory.hasUnreadComment` if buyer-authored.
  - `deleteAffectedComments` skips all block/item reads if `anyChanged === false` or the contract has 0 `discussionThreads`. Otherwise computes `ConcessionChangeSet` (`removedConcessions`, `textRanges`, `insertedAfterBlocks`, `removedBlocks`) and deletes every thread with `thread.contentRevision <= maxContentRevision` whose `footprint` matches. Up to 64 threads synchronously; >64 schedules `continueDeleteAffected`.

### C. Deletion & Cleanup Lifecycles
- **Single-contract delete (`src/convex/contracts.ts:275-295` → `src/convex/contractCleanup.ts`):**
  - Synchronous transaction: revokes `buyerLinks.currentView = null`, deletes `contractDirectory` row, deletes `contractBuyerRefreshes`, `contractHubspotAssociations`, `savedContracts`, and inserts `contractCleanups` marker (`phase: 'deliveries'`).
  - Async phases: `deliveries` (waits 60s if `providerDispatchInProgress`) → `buyerLinks` → `buyerLinkShowings` → `buyerActivity` (`Receipts`, `Openings`, `Counters`) → `buyerQuotas` (resets rateLimiter) → `discussions` (`discussionQuotaKeys`, `discussionMessages`, `discussionThreads`) → `exports` (deletes `wordExports` + `hubspotExportDeliveries` + `_storage` blob **except** rows with an active HubSpot upload pending/working/uncertain/blocked, which expire via `contractExports.expire`) → `hubspotQuotes` (drains `contractHubspotAssociations`, `contractBuyerRefreshes`, `hubspotLinkBlocks`; cancels & deletes `state === 'queued'` quote pushes after lease ends; retains dispatched/conclusive quotes and `hubspotEvents`). Preserves `operationReceipts` and frozen `templateVersions`.
- **Account deletion (`src/convex/accountDeletion.ts`):** Removed `retireAccountOperations` phase. Drains CSM evidence/preparations/appointments/attempts, selective `buyerActivityOpenings` + `Receipts` by `profileId`, transfers ownership or parks `recoveryCompanyId` for sole owner, queues `cleanupMembershipShowings`, deletes `memberships`, `profiles`, and profile `avatarId` via `deleteUnownedFile`.
- **Company deletion (`src/convex/companyDeletion.ts`):** 28 phases in `companyCleanupPhases` (dropped `outputs`, `approvals`, `emailSelectionChunks`, `decisions`) wiping every tenant table, `operationReceipts`, `contractCreationReceipts`, `wordExports`, `hubspotQuotePushes`, `templateSources` + DOCX files, and `company.avatarId`.
- **`_storage` orphan sweep (`src/convex/storageOwnership.ts`):** Daily at 04:00 UTC (`ORPHAN_GRACE = 24h`); `fileOwned` checks 5 indexed tables: `templateSources.by_originalFileId`, `profiles.by_avatarId`, `company.by_avatarId`, `wordExports.by_fileId`, `hubspotQuotePushes.by_fileId`.

### D. Frontend ↔ Backend Contract & Client Reconciliation Changes
- **Removed public Convex endpoints:** `contracts.saveChanges`, `contracts.operationResult`, `contractApprovals.*`, `contractCompletion.*`, `reviews.*`, `buyerLinkActions.ensureLatest`, `buyerLinks.currentDocument`, `contractExports.status/reserve/content/publish/acknowledge`, `discussions.threads/thread/latestReplies/message`.
- **Added / renamed public endpoints:** `contracts.save`, `approvals.{decide,request,complete}`, `buyerLinks.{ensureLatest,currentState,templateContent}`, `discussions.{list,replies}` (now standard Convex `PaginationResult`).
- **Client idempotency (`IdempotentAction` & `ContractPersistence`):**
  - `RepWorkspace` (`pushQuote`, `downloadSavedWord`) and `BuyerLinkController` (`copy`) now reuse `IdempotentAction`: timeouts keep `{ args, uncertain: true }` so Retry reuses `operationId`; any `ConvexError` unconditionally sets `this.pending = null` so subsequent clicks prepare fresh `expectedStateRevision` and `operationId`.
  - `ContractPersistence.send()` clears `this.request = null` on any `ConvexError` (including `workBlockFromError(cause)`), preventing stale rejected requests from wedging later edits.
  - `ReviewCompletedModal` in `RepWorkspace` uses `completionKey = `${contractId}:${generation}:${decidedAt}`` so dismissing the modal and then flipping a decision re-opens the modal.

---

## 5. Compromises, Leftovers & Unfinished Simplifications

Every concrete rough edge verified in the current working tree:

1. **Docs ↔ Code Mismatches (4 concrete bugs in living docs):**
   - `dinu:v8` vs `dinu:v9`: `docs/data-model.md:204` and `docs/lifecycle.md:7` document namespace **`dinu:v9`**, but `src/lib/contract/browser-storage.ts:14` still defines **`dinu:v8`** (so `localStorage` cards/openings keys did not bump).
   - Wrong `footprint` shape in docs: `docs/data-model.md:214` states `footprint ({ kind: 'source', start, end } or { kind: 'concession', itemId, optionId })`, whereas the real schema (`src/lib/discussions/validators.ts:19-29`) is `{ templateStart?, templateEnd?, blockKeys: string[], concessions: { itemId, concessionId }[] }`.
   - Stale email snapshot paragraph: `docs/email-delivery.md:7` still claims `"Delivery snapshots remain necessary for approval coverage and frozen counts"`, contradicting lines 46–50 and the deleted `emailSelectionChunks`/`snapshot` schema.
   - Stale HubSpot prose: `docs/hubspot.md:17` (and lines 25, 39, 45, 123) still references `"late acknowledgments"`, `"reserved download attempts"`, `"document revisions"`, `"review context tokens"`, and `"output evidence"`.
   - Historical logs in `docs/work/*` (`backend-simplification-plan.md`, `buyer-audit-remediation.md`, `contract-link-discussion-repair.md`, etc.) were intentionally untouched and still cite deleted modules.

2. **Redundant Queries & Backwards-Compat Scaffolding Left in Backend:**
   - **Double `buyerLinks.currentView: null` patch on delete:** `src/convex/contracts.ts:281-288` calls `ensureContractCleanup` (which queries `buyerLinks` via `by_contractId` and patches `currentView: null` at `src/convex/contractCleanup.ts:54-56`) and then *immediately* runs the exact same query and patch again in `contracts.remove`.
   - **Double `contractCleanups` query on every discussion request:** `src/convex/discussionContext.ts:20-26` calls `resolveAccess` (which calls `resolveView`, already querying `contractCleanups.by_contractId` at `src/convex/buyerLinks.ts:163-167`) and then queries `contractCleanups.by_contractId` a second time.
   - **Redundant drains & bug in `src/convex/companyDeletion.ts`:**
     - `cleanupCompanyExports` is called **three times**: in `case 'exports'` (L228), inside `cleanupCompanyContractState` in `case 'contractState'` (L31), and again in `case 'company'` (L524 & L529).
     - `case 'company'` (L496–L597) re-drains `retireCompanyHubSpot`, `csmMeetingPreparations`, `contractCleanups`, `cleanupCompanyOperations`, `cleanupCompanyExports`, `cleanupCompanyContractState`, `cleanupCompanyBuyerLinkShowings`, `csmSetupAppointments`, `csmBookingAttempts`, and authoring tables under a pre-nuke backwards-compatibility comment (`"Workers already beyond a newly added phase must still drain its children"`).
     - `case 'company'` cancels `sendJobId` and `watchdogJobId` on `csmBookingAttempts` (L563–L566) but **omits `cancelJob(ctx, row.recoveryJobId)`** (present in `case 'csmBookings'` L482).

3. **Dead / Optional / Vestigial Symbols:**
   - `DocumentCompositionEngine.baseAliases` (`src/lib/document/compose.ts:108`) and `SourceIndexOptions.aliases` (`src/lib/document/source-index.ts:46`) were introduced in `835901b` for materialized document numbering merges; `baseAliases` is now never passed by any caller (always default empty `Map`).
   - `expectedStateRevision` is still `v.optional(v.number())` on `wordExportRequest` (`src/convex/exportValidators.ts:7`), `quoteRequest` (`src/convex/hubspotQuoteValidators.ts`), and `buyerLinks.capture`/`ensureLatest` (`src/convex/buyerLinks.ts:317,454`), even though all current client callers pass it.
   - `snapshotReader.selectedItems` (`src/convex/templates.ts:582`) may now be unused since `contractSaving`, `approvals`, `buyerLinks`, `contractExports`, and `hubspotQuotes` all call `readItemsByIds()`.
   - Detached `emailDeliveries` rows: when `removeDelivery()` (`src/convex/emailDeliveries.ts:58-61`) hits `providerDispatchInProgress`, the row is preserved so the in-flight action can settle, after which it sits unreferenced in `emailDeliveries` until contract or company deletion (no cron sweeps detached settled deliveries).

4. **Intentional Simplification Trade-Offs & Heavy Adjacent Subsystems Left Intact:**
   - **Non-idempotent comment retries on timeout:** `DiscussionSession` (`src/lib/discussions/session.svelte.ts:817-926`) mints a fresh `crypto.randomUUID()` on every click of `submit` / `submitReply` / `submitEdit` / `deleteMessage`. If `/api/buyer/discussions` times out at 15s *after* committing in Convex, clicking Comment again posts a duplicate comment (consciously accepted to eliminate `OperationStatus.svelte` + `recovery.svelte.ts`).
   - **Pagination ceiling & `SplitRequired`:** `PaginatedFeed` caps at `MAX_PAGES = 20` × `PAGE_SIZE = 200` (4,000 threads/replies) and does not handle Convex `pageStatus: 'SplitRequired'` / `splitCursor`.
   - **Heavy untouched/lightly-touched client subsystems:** `src/lib/contract/editors.svelte.ts` (1,154 LOC) and `src/lib/contract/snapshot-cache.ts` (770 LOC) still carry complex hover/displacement/intent flight scheduling; `DocumentDomain.acceptOverlays` still rebuilds a fresh `PlaybookGeometryIndex` whenever `appliedOverlays` changes on a buyer link; `src/convex/_generated/api.d.ts` was manually maintained rather than regenerated by `npx convex dev`.
   - **CSM booking & HubSpot Delivery/Quotes/Uninstall subsystems** were left structurally untouched except where they touched renamed/deleted contract tables.

---

## 6. Verification, Test Changes & Blind Spots

### Automated Commands Executed & Passed After Final Edit (All Exit 0)
1. `npx tsc --project src/convex/tsconfig.json --noEmit` — **0 errors**
2. `npm run verify`:
   - `npm run test:ssr` — **3/3 files, 16/16 tests passed** (`startup-streams`, `contract-titles`, `loading`)
   - `npm run test:backend` — **16/16 files, 105/105 tests passed**
   - `npm run test:client` — **4/4 files, 21/21 tests passed** (`csm-availability`, `scheduling`, `caching`, `buyer-download`)
   - `npm run test:components` — **23/23 files, 158/158 tests passed**
   - `npm run test:perf` — **7/7 files, 38/38 tests passed** (saving, scheduling, caching, creation, startup, CSM availability/provider)
   - `npm run check` (`svelte-kit sync && svelte-check --tsconfig ./tsconfig.json && npm run check:tools`) — **0 errors, 0 warnings**
   - `vite build` (`@sveltejs/adapter-vercel`) — **succeeded (23.6s)**
   - `npm run verify:loading-bundles` — **passed** (public frame, persistent Contracts, creation, saved/help admission, buyer contract entry)
3. `npm run seed:verify` — **passed**: 48/48 compositor states, 112 blocks, 55 items, 55 triggers, 21 concessions, 29 locations, 0 production reconciliation mismatches.

### Test Files Deleted, Rewritten, or Adjusted (and Why)
- **Deleted (3 files):**
  - `tests/components/viewer/BuyerChangeActionsHarness.svelte` — harness for deleted `BuyerChangeActions.svelte`.
  - `tests/components/viewer/materialized-composition-snappiness.test.ts` — tested deleted `contractDocuments` materialized composition mode.
  - `tests/client/downloads/download-journal.test.ts` — tested deleted `download-journal.ts`.
- **Rewritten / significantly adapted (maintaining guarantees per `AGENTS.md`, zero new test files added):**
  - `tests/backend/contracts/saving.test.ts` — Rewritten from `contracts.saveChanges` + `contractChanges` to `contracts.save` + flat `concessions[]`; preserved exact zero-read/zero-write no-op, replay, stale-conflict, 0-block-read, foreign-item rejection, and obsolete-field rejection assertions.
  - `tests/backend/exports/exports.test.ts` & `word-actions.test.ts` — Rewritten from 6-step `reserve`/`publish`/`acknowledge` on `hubspotExports` to 2-step `prepare`/`commit` on `wordExports`. Dropped `acknowledge` assertions because browser ack no longer exists; added stale-revision commit refusal check.
  - `tests/backend/exports/buyer-download.test.ts` — Updated boundary query mocks from `buyerLinks:currentDocument` to `buyerLinks:currentState` + `buyerLinks:templateContent` + `buyerLinks:authorizeDownload`.
  - `tests/backend/hubspot/activity.test.ts` — Updated to `contracts.save` & `approvals.decide`. **Notable adjustment (audit this):** In `"relinks and renames the contract..."` (L202), added `vi.advanceTimersByTime(6 * 60_000)` before `hubspotDelivery.pump` because the 2-step `readyExport` commit now inserts the `'downloaded'` event *immediately* (rather than on a later `acknowledge`), so the earlier `markUnavailable` pump had already leased/dispatched it and it needed the 5-minute claim window to expire before the post-relink pump could mark it `'paused'`.
  - `tests/backend/hubspot/{delivery,quotes,uninstall,security,refresh}.test.ts` & `tests/support/linked-contract.ts` — Updated table/field names (`wordExports`, `concessions[]`, `expectedStateRevision`).
  - `tests/client/caching.test.ts` — Removed `approved` IDB store assertions, bumped IDB schema checks to v17.
  - `tests/components/contracts/fixtures.ts`, `tests/components/loading/loading-recovery.test.ts`, `tests/components/viewer/buyer-discussion-regressions.test.ts` — Updated mock return shapes (`api.buyerLinks.ensureLatest`, `api.buyerLinks.currentState`/`templateContent`, Convex `PaginationResult` `{ page, isDone, continueCursor }`, removed `deleted: false`).
  - `data/reference/compositor.json` — Refreshed 48 states (18 `sha256` drifted due to pre-existing commit `27dfb0c` changing `patchAnnotation` for multi-change secondary targets; all 48 `provenanceSha256` drifted due to pre-existing `835901b`/`9b84c57` additions of `discussion` coordinates and `highlightKind`).

### Blind Spots — Explicitly NOT Verified
- **Zero live browser or Playwright execution** (per `AGENTS.md`). None of the DOM geometry, focus management, multi-anchor `ReviewTags` layout, `ReviewCompletedModal` dismissal/reopen, buyer link live updates, comment highlighting across renumbered references, or `PaginatedFeed` live pagination were exercised in a real browser.
- **Zero live Convex deployment push or DB nuke/re-seed (`npx convex dev` / `npm run convex:seed`):** Schema push, real Convex codegen (`_generated/*`), cron execution, and runtime validator enforcement against live Convex were not run.
- **Zero automated test coverage for the newly written modules:**
  - `src/convex/approvals.ts` (`request` cooldown/retry/skipped branches, `complete` triggering-reviewer CC, `decide` `approved ↔ rejected` flip & `removeDelivery` cleanup).
  - `src/convex/discussionInvalidation.ts` (`deleteAffectedComments` >64 threads continuation, `drainThreadMessages` >64 messages, `maxContentRevision` fencing, `extractFootprint` / `footprintAffectedByChanges` edge cases).
  - `src/lib/discussions/session.svelte.ts` (`PaginatedFeed` multi-page cursor shifts, `buyerRequest` 401 refresh, `continueAsBuyer`, composer switching while busy).
  - `src/lib/contract/idempotent-action.svelte.ts` (timeout → contract edit → `ConvexError` clear → retry flow).
  - `src/lib/buyer/contract.svelte.ts` (`currentState` + `templateContent` split under `retry()` / `release()` / rapid updates).
  - `src/lib/document/review-anchors.ts` (multi-block `targets` deduplication & ordering).
  - `src/lib/playbook/document-overlay.ts` (`filterOverlappedExplanations`).
- **Zero live external provider checks** (Loops transactional send/CC/rate limit, HubSpot OAuth/Notes/Files/Quotes/Journal, Clerk webhooks, Cal webhooks).

---

## 7. Where an Adversarial Reviewer Should Look First

Ordered roughly by likelihood of a real bug or broken invariant:

### 1. Background HubSpot Buyer-Name Refresh Bumping `savedContracts.stateRevision`
- **File:** `src/convex/hubspotRecipients.ts` (L183–L188)
- **Why it's dangerous:** When HubSpot background refresh resolves or updates the buyer company name on a contract, `hubspotRecipients.commit` increments `savedContracts.stateRevision`. Because `contracts.save`, `approvals.decide`, `ContractPersistence`, `wordExports`, `hubspotQuotes`, and `buyerLinks.capture` all gate on `stateRevision`, a background buyer-company rename can trigger **false edit conflicts** in `ContractPersistence.accept()` (`src/lib/contract/persistence.svelte.ts:196`), spurious `"This contract changed"` rejections on `approvals.decide`, or failed Word/Quote/link commits — even though zero concessions changed. This also contradicts `docs/data-model.md:168` (`"Buyer names stay outside saved intent and confirmed caches"`).

### 2. `BuyerContract.release()` / `retry()` Microtask Race on `templateReads`
- **File:** `src/lib/buyer/contract.svelte.ts` (L128–L152, L394–L425)
- **Why it's dangerous:** `loadTemplate` caches in-flight `queryOnce` promises in `this.templateReads`, deleting the entry inside `.finally()` (a microtask). `release()` aborts `this.lifetime` (which aborts the `readAttempt.signal` bound to that `queryOnce`) but **does not call `this.templateReads.clear()`**. When `retry()` calls `this.release()` followed synchronously by `this.start()` → `subscribeState()`, if `client.onUpdate` delivers cached `currentState` synchronously before the old `.finally()` microtask runs, `loadTemplate` attaches to the **just-aborted promise** in `templateReads` and immediately fails the retry.

### 3. Approval Lifecycle Edge Cases & Concurrent Admin Race
- **File:** `src/convex/approvals.ts` (L135–L146, L184–L238, L308–L395)
- **Look closely at:**
  - **`approvals.complete` lacks `expectedDecidedAt`:** If Admin A finishes review at `t1`, Admin B opens the completion modal, Admin A flips a concession from `approved → rejected` at `t2` (same `review.generation`), and Admin B clicks "Send notification", `complete` accepts the stale confirmation and emails the `t2` counts with Admin A's `t2` `reviewerId` even though Admin B reviewed `t1`.
  - **`approved → rejected` does not touch `buyerLinks.currentView`:** Because `syncBuyerLink` only runs when `contractReadiness(nextConcessions).ready` (`pending === 0 && rejected === 0`), declining a previously-approved concession leaves the old approved wording live on the buyer link until the rep removes the declined concession. Verify whether this is acceptable product behavior.
  - **`approvals.request` `'skipped'` fallthrough:** If an existing `emailDeliveries` row reached `state.kind === 'skipped'`, `deliveryStatusOf` returns `null`, falling through to L258 to log a **second** HubSpot `'requested'` activity event and create a new delivery row.

### 4. `DiscussionSession` Concurrency, Non-Idempotent Retries, and Pagination Hazards
- **File:** `src/lib/discussions/session.svelte.ts` (L74–L189, L346–L356, L817–L926)
- **Look closely at:**
  - **Duplicate comments on timeout:** Fresh `crypto.randomUUID()` on every click means a 15s timeout after server commit produces a duplicate thread/reply on retry.
  - **Silent false-success return in `deleteMessage` (L898):** `if (this.readOnly || this.deletingMessageId || this.activeComposer?.busy) return;` returns `undefined`, which `DiscussionMessage.svelte` treats as a successful delete (no error string) if ever triggered while a composer is busy.
  - **Focus steal on busy composer:** Setting `session.selected = otherId` while `activeComposer.busy` is true updates `selectedThread` without clearing `activeComposer`; when `submit()` resolves, `if (this.activeComposer === composer)` overwrites `this.selectedThread = result.threadId`.
  - **`PaginatedFeed` churn:** Live deletions in page 0 shift `continueCursor`, causing `trimAfter(0)` + re-subscribing all subsequent pages (causing brief flash/disappearance of threads >200) and unhandled `SplitRequired` pages if a query ever splits.

### 5. Comment Structural Invalidation & Cross-Reference Quote Matching
- **Files:** `src/convex/discussionInvalidation.ts`, `src/lib/discussions/anchors.ts` (L162–L319), `src/lib/discussions/dom-anchor.ts` (L155–L239)
- **Look closely at:**
  - **Zero-length insertion at exact comment boundary:** `footprintAffectedByChanges` L314 uses strict interior check `fStart < start && start < fEnd` for `start === end` insertions; verify whether an insertion directly adjacent to a comment start/end could alter sentence meaning or break `anchorPassage`/`dom-anchor.ts` without invalidating the comment.
  - **`continueDeleteAffected` re-scanning from `cursor: null`:** When >64 threads exist, `deleteAffectedComments` processes the first 64 and schedules `continueDeleteAffected` starting at `cursor: null` (re-reading surviving threads from the first 64). Safe because deletion is idempotent and fenced by `maxContentRevision`, but verify Convex read/write budgets if a contract has hundreds of threads with large reply counts.
  - **`matchesQuoteWithReferences` greedy `indexOf` (L197):** Uses left-to-right `savedQuote.indexOf(segment, cursor + 1)` across literal fragments split by cross-references. Worth testing against quotes containing repeated short literal separators (e.g. `", "` between `"Section 1, Section 2, and Section 3"`).
  - **Multi-paragraph comment spanning a non-adjacent structural insertion:** `footprint.blockKeys` records blocks that contributed `parts`; if a concession inserts a new paragraph between `blockKeys[i]` and `blockKeys[i+1]`, L307 catches `insertedAfterBlocks.has(footprint.blockKeys[i])`, **except** if there was an empty/table/skipped block in between.

### 6. `ContractPersistence` Lost-Response Reconciliation vs. Teammate Edits
- **File:** `src/lib/contract/persistence.svelte.ts` (L182–L204, L305–L334)
- **Why it's dangerous:** If Save A commits on Convex (`lastOperation = A`, `stateRevision = 8`), its HTTP response is lost, and *before* Client A's live subscription observes `stateRevision = 8`, Teammate B commits Save B (`lastOperation = B`, `stateRevision = 9`) — Client A sees `next.lastOperationId === B !== A`, so `own` is `null`. Client A still has `this.request = A` non-null, so it skips the `conflict` branch (`!this.request`) and eventually retries Save A, which hits `operationReceipts` and returns `{ status: 'saved', state: stateAtRev8 }`. Line 305 skips updating `this.confirmed` (since `olderContractState(8, 9)` is true), **but line 308 calls `this.acknowledgeRequest(result.state)`**, which sets `this.baseStateRevision = 8` (backwards from 9) while `this.confirmed.stateRevision` is 9; if `draftSelections` differs from Rev 8 it immediately fires a new save with `expectedStateRevision = 8` (triggering conflict), or if `draftSelections` matched Rev 8 it clears `draftSelections = null` and silently adopts Teammate B's Rev 9.

### 7. Export / Quote Action `finally` Blob Disposal & Partial Commit
- **Files:** `src/convex/wordExportGeneration.ts` (L37–L49), `src/convex/hubspotQuoteActions.ts` (L61–L72), `src/convex/storageOwnership.ts` (L9–L48)
- **Look closely at:** Both actions call `ctx.storage.store(blob)`, run `commit`, and call `storageOwnership.discardFile({ fileId })` in `finally`. If `commit` succeeds, `fileOwned` sees `wordExports.by_fileId` or `hubspotQuotePushes.by_fileId` and preserves the blob. Audit timeout/abort behavior between `commit` and `finally`, and confirm concurrent retries cannot drop an adopted blob.

### 8. `companyDeletion.ts` & `contractCleanup.ts` Completeness Audit
- **Files:** `src/convex/companyDeletion.ts` (L201–L610), `src/convex/contractCleanup.ts` (L89–L262)
- **Look closely at:**
  - Verify all 51 tables in `src/convex/schema.ts` against `companyDeletion.ts` — ensure no tenant table is missed, fix the missing `cancelJob(ctx, row.recoveryJobId)` in `case 'company'` (L563), and collapse the 3× duplicate `cleanupCompanyExports` / 2× duplicate drains.
  - Check `contractCleanup.ts` `exports` phase (L202–L208): if a deleted contract had a HubSpot download whose upload stays `pending`/`blocked` permanently (e.g., HubSpot delivery disabled), `wordExports` + `hubspotExportDeliveries` survive `contractCleanup` until `contractExports.expire` clears `fileId` after 30 days — note `contractExports.expire` clears `fileId` and `expiresAt` but never deletes the `wordExports` or `hubspotExportDeliveries` metadata rows (by design for historical `hubspotEvents` provenance, until `companyDeletion`).

### 9. `compose.ts` Cache Key & Multi-Change `patchAnnotation` Drift
- **Files:** `src/lib/document/compose.ts` (L366–L408, L689–L715, L926–L934), `data/reference/compositor.json`
- **Look closely at:**
  - Verify `container-discussion-v2` (L690) includes every field that affects `discussion.offset` on equal/replacement runs inside `composeContainer`, just as `generated-discussion-v3` (L927) now includes `paragraph.annotation.discussionOffset ?? 0`.
  - Confirm that commit `27dfb0c`'s `patchAnnotation` trigger-inheritance change (which caused the 18 `sha256` updates when refreshing `data/reference/compositor.json`) is the intended highlight/click behavior for multi-change secondary targets in Exhibit A.
