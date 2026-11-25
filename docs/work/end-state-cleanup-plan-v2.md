# End-State Cleanup & Hardening Plan (v2 — Reconciled)

This plan supersedes [end-state-cleanup-plan.md](end-state-cleanup-plan.md) by incorporating every verified finding from [end-state-cleanup-plan-review.md](end-state-cleanup-plan-review.md) and [end-state-cleanup-reviewer-context.md](end-state-cleanup-reviewer-context.md). It finishes and hardens the two uncommitted refactors currently in the working tree:
1. [playbook-only-refactor-handoff.md](playbook-only-refactor-handoff.md) — Playbook-only contract model.
2. [template-authoring-toolbar-simplification-handoff.md](template-authoring-toolbar-simplification-handoff.md) — Unified Rep/Buyer template authoring & toolbar simplification (Pass 2 currently unverified due to runner exit 137).

> **Execution ground rules (`AGENTS.md`):**
> - Start from the best, simplest, most robust end state and work backward. Backwards compatibility is **not** required (a clean DB reset is assumed).
> - Always read `src/convex/_generated/ai/guidelines.md` before modifying Convex functions.
> - Do **not** add new tests unless explicitly asked; maintain affected existing tests/fixtures and preserve all `npm run test:perf` guarantees without weakening assertions.
> - Do **not** use Playwright/browser automation; verify via `npm run verify`, `npx tsc --noEmit -p src/convex/tsconfig.json`, `npm run seed:verify`, and Prettier checks.

---

## 1. Locked Decisions & Baked-In Defaults

### User-Locked Decisions (Final)
1. **Admin revoke (`approved → rejected`) on a live buyer link:**
   - Immediately pull back **only** the revoked concession from `buyerLinks.currentView`, while continuing to hold back newly drafted `pending` edits until the contract is ready.
   - Add targeted `retractBuyerLinkConcession(ctx, root, itemId, preloaded?)` that unconditionally removes `itemId` from `link.currentView.concessions` if present (even if an older option of `itemId` was live), bumps `contentRevision`, refreshes `title`/`buyerName`/`displayIdentity`, and runs `deleteAffectedComments` for that single removal. When `contractReadiness(nextConcessions).ready` is `true`, full `syncBuyerLink` runs as usual.
2. **Separate `stateRevision` from `metadataRevision`:**
   - **`stateRevision`** tracks **concessions and review state only** (`contracts.save`, `approvals.decide`) — used by `expectedStateRevision`, `ContractPersistence.baseStateRevision`, `wordExports`, `hubspotQuotes`, and `buyerLinks.capture`. Never bumped by `hubspotRecipients.commit`, `contractPolicy.markDealUnavailable`, `hubspotDeals.commit` (relink), or `contracts.rename`.
   - **`metadataRevision`** is a lightweight monotonic freshness counter on `savedContracts` (and `contractState`), incremented automatically inside `patchContract` on any root/association write and inside `hubspotRecipients.commit`. Used exclusively by `olderContractState` (`next.metadataRevision < current.metadataRevision`) and `RepWorkspace.stateReconciled` so stale replies/IDB writes never clobber renames, relinks, deal availability, or buyer names — without touching `savedAt` directory ordering or triggering false save conflicts.
   - Enforce title freshness explicitly via `expectedTitle` on `contractExports.commit` and `hubspotQuotes.commit`.
3. **Delete legacy migration & formatting-repair scaffolding completely:**
   - Delete `src/convex/authoringMigration.ts`, `src/convex/templateSourceFormatting.ts`, `analyzeExisting` in `src/convex/templateSourceParser.ts` (keeping live `prepare`), the `authoringMigrations` table, `company.authoringMigration`, legacy migration scripts under `scripts/`, and all migration gates across `templates.ts`, `playbookItems.ts`, `authoringValidation.ts`, `deletionValidators.ts`, and `companyDeletion.ts`.
   - **Keep** `src/convex/authoringValidation.ts` (`certify`, `writeValidationFacts`, `readValidationFacts`, `validationCertified`, `templateSourceCertificates`, `templateSourceValidationChunks`), and tighten `templateVersions.validation` from `v.optional(...)` to **required** (`format: 0 | VALIDATION_CODEC_VERSION`, `fingerprint: string`).

### Two Micro-Decisions (Recommended Defaults Baked In — Confirm Before Executing)
1. **`hubspotQuotes.gated()` on explicit contract rename while a quote push is `queued`:**
   - **Default baked in:** Check `root.title !== row.title` in `gated()` so renaming a contract aborts an unsent queued quote push instead of dispatching a quote with the old `hs_title` (preserving pre-refactor rename behavior while background `hubspotRecipients.commit` buyer-name refreshes never touch `title` or `stateRevision`, so they never abort queued pushes).
   - *Alternative:* Omit `root.title !== row.title` in `gated()` if queued pushes should proceed with the title captured at `prepare`/`commit`.
2. **`approvals.complete` on stale `expectedDecidedAt`:**
   - **Default baked in:** Return `{ status: 'skipped' }` (recording the receipt), matching existing stale `expectedGeneration` and pending-concession handling at `src/convex/approvals.ts:333-351` and `docs/email-delivery.md:48`, so `ReviewCompletedModal` cleanly re-keys to the new `${contractId}:${generation}:${decidedAt}` without flashing a transient error banner.
   - *Alternative:* Throw `ConvexError` if you prefer an explicit error banner when an admin confirms a stale completion before their live subscription updates.

---

## 2. Target End-State Invariants

1. **Honest contract revisioning & monotonic metadata freshness:** `stateRevision` advances only on concession/review mutations (`contracts.save`, `approvals.decide`); `metadataRevision` advances on every metadata/association/buyer-name mutation so `olderContractState` never regresses or clobbers equal-`stateRevision` updates; `savedAt` advances monotonically only on saves/decisions/renames (`Math.max(now, savedAt + 1)`), preserving deterministic directory ordering and zero same-ms flakes.
2. **Single live/draining/deleted choke point:** Every `buyerLinks` read checks `currentView !== null` via shared helpers (`liveLinkFor`, `hasActiveLinkForCreator`). Link revocation on delete happens in one place (`ensureContractCleanup`). No mutation redundantly re-reads `memberships`, `contractCleanups`, `contractDirectory`, or `contractHubspotAssociations` when unneeded or already verified.
3. **Zero prose reads on hot save/invalidation paths & unified overlap geometry:** Multi-concession conflict detection (`contractSaving.ts`) and comment invalidation (`discussionInvalidation.ts`) read compact certified `ValidationSourceFacts` (`readValidationFacts`) rather than full up-to-8 MiB `templateSourceChunks` prose (falling back to `blocks()` only before async `certify` completes). One shared `ValidationSourceFacts`-based overlap/impact module drives both buyer-explanation filtering and comment invalidation (including empty/table/removed intermediate blocks, synthetic inserted paragraphs, and boundary insertions).
4. **Hard Convex transaction-budget compliance with zero skipped rows:** `discussionInvalidation.ts` never reads messages inline during thread pagination, checks `cleanupBudget(ctx).exhausted()` **before** every `.paginate()`, processes 100% of every small page before forwarding `page.continueCursor`, and drains messages via a batched cursorless `drainThreadMessages({ threadIds })` worker using `cleanupBudget(ctx).drain(...)`.
5. **Uniform idempotency & complete state machines:** One receipt table (`operationReceipts`, 24h TTL) handles all idempotent commands including `contracts.create` (`contractCreationReceipts` deleted). Every mutation writing receipts gets stable `operationId` retry reuse + definite-error rotation from its client (including `DiscussionSession` & `DeleteConfirmationState`). `ContractPersistence` never regresses `baseStateRevision` or silently overwrites newer teammate revisions on stale replay. `emailDeliveries` always records valid terminal transitions and cleans up detached contract rows before scheduling dead timers.
6. **Zero legacy drag & strict 1:1 parity:** No migration modules/tables/scripts, no rolling-deploy deletion fallbacks, no loose optional validators, no hollow `changes: []` concessions, narrow Convex wire validators (`appliedOverlay` stays lean), and 100% parity across code, Convex codegen, `data/convex/playbookItems.jsonl`, browser caches (`dinu:v9`), and all living docs.

---

## 3. Intentional Complexity — Do NOT Break or Remove

Preserve all of these load-bearing mechanisms:
- **`authoringValidation.ts` + compact binary `structure` codec + `templateSourceCertificates` + `templateSourceValidationChunks` + `templateVersions` byte counters:** Keeps Playbook authoring, multi-concession contract saves, and comment invalidation well within Convex's 16 MiB / 4,096 read limits and perf budgets; async `certify` keeps bulk import within single-transaction write budgets.
- **`itemHeadFields.currentRevisionId` optional on `playbookItems` table, required on `detailFields`:** Required for the atomic 2-step insert in `createAuthoringItem`.
- **`savedContracts.lastOperation` alongside `operationReceipts`:** Enables passive lost-response reconciliation through the existing live `contracts.state` subscription without polling.
- **`hubspotQuotes.commit` 2-pass `payload-required` flow + `discardFile` in `finally` + `storageOwnership.ts` `fileOwned`:** Prevents duplicate `_storage` blobs on deduplicated canonical pushes and prevents leaked blobs across all 5 owner tables.
- **`wordExports` separate 1h `downloadExpiresAt` vs physical `expiresAt` (`+15m` / `+30d+15m`):** Keeps `prepare` clock-free/cacheable while respecting download grace and HubSpot's 30-day attachment hold.
- **`buyerLinks.capture` returning an existing live link before checking readiness/revision:** Intentionally allows copying an already-created permanent link while pending edits exist.
- **`emailNotifications.ts` passing `companyName: event.title`:** `emails/approval.lmx` and `emails/decision.lmx` render `"the contract that's being prepared for {data.companyName}"`.
- **Two `$derived` `createDraftValidator()` closures in `AuthoringContext` & narrow args in `evaluateConcessionAddition`:** Prevents single-slot cache thrashing in `geometry-index.ts` and avoids re-validating geometry on keystrokes.
- **`SelectionSurface` keeping break indexing when `allowBoundarySelection === false`:** Required for multi-paragraph text drags on `/template/buyers`.
- **`src/routes/api/buyer/[token]/download/+server.ts` creating a fresh second `ConvexHttpClient` for `authorizeDownload`:** Avoids a pinned read timestamp from the first query.
- **`contractCleanup.ts` scheduling `hubspotQuotes` instead of falling through from `exports`:** Required by Convex's single-`.paginate()`-per-mutation rule.
- **`BuyerDiscussions` Clerk `__session` 401 guard + `coordinateDiscussionViewer`:** Prevents signed-in teammates with expired JWTs from silently posting anonymously as `"Buyer"` and prevents multi-tab cookie races.
- **`src/lib/document/paragraph-migration.ts` (`normalizeParagraphBlocks`):** Still imported by `scripts/production-seed.mjs:7` to convert the archived `data/migration/source` export; keep it (or inline only if desired) so `npm run seed:restore-export` stays intact.

---

## 4. Phased Execution Plan

Execute stages in order, verifying at each boundary so regressions never pile up.

---

### Stage 0 — Establish a Green, Verified Baseline & Git Checkpoint

Pass 2 of the authoring/toolbar refactor was never compiled, formatted, or tested, and broke committed seed data. Stabilize and checkpoint before refactoring further.

1. **Regenerate committed seed data** so it satisfies Pass 2's non-blank instruction validation (`src/lib/playbook/validation.ts:138-144`):
   - `scripts/production-seed.mjs:502-511` already strips blank instruction keys, but `data/convex/playbookItems.jsonl` still has `"howToExplainToBuyers": ""`, `"commonObjections": ""`, `"negotiation": ""`.
   - Run `npm run seed:restore-export && npm run seed:reconcile` (reading `data/migration/source`) so `data/convex/playbookItems.jsonl` and `data/migration/{mapping,reconciliation}.json` match.
2. **Regenerate Convex generated files:**
   - Run `npx convex codegen` to replace the hand-edited `src/convex/_generated/api.d.ts`. *(Note: previously failed in restricted sandbox with `ENOTFOUND o1192621.ingest.sentry.io`; run unsandboxed if network/CLI requires it.)*
3. **Format Pass 2's unformatted files:**
   - Run `npx prettier --write` on the Pass 2 modified files listed in [template-authoring-toolbar-simplification-handoff.md](template-authoring-toolbar-simplification-handoff.md) so formatting drift doesn't pollute later diffs.
4. **Verify Pass 2 baseline completely:**
   - Run `npm run verify`, `npx tsc --noEmit -p src/convex/tsconfig.json`, and `npm run seed:verify`.
   - Fix any compile, type, or test errors surfaced in Pass 2's unverified files (`templates.ts`, `playbookItems.ts`, `operator.ts`, `validation.ts`, `authoring-context.svelte.ts`, `authoring-controller.svelte.ts`, `TemplateWorkspace.svelte`, `SourceSelectionToolbar.svelte`) before starting Stage 1.
5. **Recommended git checkpoint commit:**
   - Create a local checkpoint commit (if the user permits committing) once Stage 0 is 100% green, giving Stages 1–5 a clean diff boundary separate from the ~400 uncommitted files from Refactors 1 & 2.

---

### Stage 1 — Contract Revisions (`stateRevision` vs `metadataRevision`), Buyer-Link Retraction & Review/Email State Machines

#### 1.1 Split `stateRevision` vs `metadataRevision`, monotonic `savedAt`, & explicit `expectedTitle`
- **Add `metadataRevision: v.number()` across contract persistence & client freshness:**
  - `src/convex/contractValidators.ts:22` (`storedContract`), `src/convex/savedContractValidators.ts:21` (`contractState`), `src/convex/contracts.ts:43` (`stateOf`), `src/convex/contracts.ts:317` (`createContract`: initialize `stateRevision: 0, metadataRevision: 0`), `src/lib/contract/persisted-values.ts:73` (`validContractState`: require `natural(value.metadataRevision)`).
  - `src/convex/contractState.ts:145-148` (`patchContract`): whenever `Object.keys(rootChanges).length > 0 || associationChanged`, automatically patch `metadataRevision: contract.root.metadataRevision + 1` onto `savedContracts` and `contract.root`.
  - `src/convex/hubspotRecipients.ts:183-188,204-209`: replace `stateRevision: current.root.stateRevision + 1` with `metadataRevision: current.root.metadataRevision + 1` (never touch `stateRevision` or `savedAt`).
  - Leave `src/convex/hubspotQuotes.ts:346` (`quoteRequests` patch) untouched — `quoteRequests` is not part of `contractState`/`contractMetadata`, so it does not bump `stateRevision` or `metadataRevision`.
- **Remove `stateRevision` bumps from all non-concession/non-review mutations:**
  - `src/convex/contractPolicy.ts:45` (`markDealUnavailable` — `patchContract` bumps `metadataRevision`, leaves `stateRevision` and `savedAt` untouched).
  - `src/convex/hubspotDeals.ts:208` (`commit` relink branch — `patchContract` bumps `metadataRevision`, leaves `stateRevision` and `savedAt` untouched).
  - `src/convex/contracts.ts:269` (`rename` — `patchContract` bumps `metadataRevision`, keeps `title`, monotonic `savedAt`, and conditional `buyer: { kind: 'manual' }`).
- **Update client freshness guards & test fixtures:**
  - `src/lib/contract/saved.ts:68-70`: update `olderContractState(next, current)` to `return next.metadataRevision < current.metadataRevision;`.
  - `src/lib/components/workspace/RepWorkspace.svelte:392`: update `stateReconciled` to `persistence.confirmed.metadataRevision >= metadata.data.metadataRevision`.
  - Update test fixtures constructing raw `savedContracts` / `ContractState` / `ContractMetadata` (`tests/backend/contracts/saving.test.ts`, `tests/client/caching.test.ts`, `tests/client/snapshot-storage-observer.ts`, `tests/components/contracts/fixtures.ts`, `tests/support/linked-contract.ts`) to include `metadataRevision`.
- **Fix same-millisecond `directoryWrites` flake deterministically via monotonic `savedAt`:**
  - Set `savedAt = Math.max(Date.now(), contract.root.savedAt + 1)` in `src/convex/contractSaving.ts:149`, `src/convex/approvals.ts:79`, and `src/convex/contracts.ts:262` (`rename`). Verify `tests/backend/contracts/saving.test.ts:229-268` passes deterministically even when consecutive saves execute within the same millisecond.
- **Explicit `expectedTitle` freshness checks:**
  - `src/convex/wordExportGeneration.ts:39-46` + `src/convex/contractExports.ts:117-158` (`commit`): pass `expectedTitle: prepared.title` into `contractExports.commit` and throw `ConvexError` if `contract.root.title !== args.expectedTitle`.
  - `src/convex/hubspotQuoteActions.ts:51-57` + `src/convex/hubspotQuotes.ts:224-268` (`commit`) and `hubspotQuotes.ts:100-111` (`gated`): pass `expectedTitle: prepared.title` into `hubspotQuotes.commit` and throw `ConvexError` if `contract.root.title !== args.expectedTitle`; in `gated()`, also return `null` if `root.title !== row.title` (per Default #1 above). Update affected direct-mutation callers in `tests/backend/exports/` and `tests/backend/hubspot/` to pass `expectedTitle`.

#### 1.2 Buyer-link retraction on Admin revoke & single live-link choke point
- **`src/convex/buyerLinks.ts` (`L57-142, L227-243`):**
  - Factor shared helpers:
    - `liveLinkFor(ctx, contractId)`: calls `linkFor` and returns `link` only if `link?.currentView !== null`.
    - `hasActiveLinkForCreator(ctx, companyId, creatorId)`: iterates `by_companyId_and_creatorId` and returns `true` on the first row with `link.currentView !== null`.
    - `patchBuyerLinkMetadata(ctx, link, root)`: eliminates title/`buyerName`/`displayIdentity` duplication between `syncBuyerLink` (`L86-97`) and `syncBuyerLinkMetadata` (`L125-141`).
  - Add `retractBuyerLinkConcession(ctx, root, itemId, preloaded?)`:
    - Look up `link = await liveLinkFor(ctx, root._id)`. If `!link || link.companyId !== root.companyId || !(itemId in link.currentView.concessions)`, return early.
    - Build `nextConcessions` by omitting `itemId` from `link.currentView.concessions` (unconditionally, even if an older option of `itemId` was live).
    - Patch `buyerLinks.currentView` with `nextConcessions`, `contentRevision: prevView.contentRevision + 1`, refreshed `title`/`buyerName`/`displayIdentity`.
    - Call `deleteAffectedComments(ctx, root, prevView.concessions, nextConcessions, prevView.contentRevision, preloaded)`.
- **`src/convex/approvals.ts` (`L143-145`):**
  - If `contractReadiness(nextConcessions).ready` is `true`, call `syncBuyerLink(ctx, updated.root, { itemsById })`.
  - Else if `current.status === 'approved' && nextStatus === 'rejected'`, call `retractBuyerLinkConcession(ctx, updated.root, args.itemId, { itemsById })`.
- **`src/convex/accounts.ts` (`L205-212`):**
  - Update **both** checks in `readSetupProgress` — replace `by_companyId_and_creatorId .first()` with `hasActiveLinkForCreator(ctx, access.companyId, access.profile._id)` AND replace `linkFor(ctx, contract.contractId)` (`L211`) with `liveLinkFor(ctx, contract.contractId)` — so a revoked link on a draining deleted contract never falsely completes `'buyer-link'`.
- **`src/convex/contracts.ts` (`L283-288`):**
  - Delete the duplicate `buyerLinks` lookup and `currentView: null` patch from `contracts.remove` (`ensureContractCleanup` at `src/convex/contractCleanup.ts:54-56` already executes it in the same transaction).

#### 1.3 Fix approval & email delivery state-machine bugs
- **`src/convex/approvals.ts` (`complete`, `L308-395`) + `src/lib/contract/review-controller.svelte.ts` + `tests/backend/hubspot/activity.test.ts:128`:**
  - Add `expectedDecidedAt: v.number()` to `approvals.complete` args and receipt `inputs`.
  - If `completion.kind === 'awaitingConfirmation' && completion.decidedAt !== args.expectedDecidedAt`, return `{ status: 'skipped' }` and record the receipt (per Default #2; consistent with stale `expectedGeneration` and pending-concession staleness).
  - Update `ContractReviewController.resolveCompletion()` (`L199-204`) to pass `expectedDecidedAt: this.completion.decidedAt`, and update `reconcile()` (`L95-102`) to compare against `this.completionKey` (clearing `completionAttempt` & `completionError` when either `generation` OR `decidedAt` changes). Update `tests/backend/hubspot/activity.test.ts:128`.
- **`src/convex/approvals.ts` (`request`, `L185-258`):**
  - Track `const alreadyLoggedRequest = Boolean(existing && existing.generation === contract.root.review.generation)`.
  - When an existing same-generation `emailDeliveries` row exists with `state.kind === 'skipped'` (so `deliveryStatusOf` returns `null`), call `removeDelivery(ctx, delivery)` and create a **fresh** delivery with the company's **current** `recipientEmail` (never calling `restartDelivery` on a skipped row, which rejects `'skipped'` and would reuse a stale `recipientEmail`), while **skipping** the duplicate `activity(..., 'requested', ...)` at `L258` when `alreadyLoggedRequest` is true.
- **`src/convex/emailDeliveries.ts` (`beginDispatch`, `L281-306`):**
  - When `!to` (ineligible target or missing recipients), call `await recordOutcome(ctx, delivery, { status: 'skipped' })` and `await cancelJob(ctx, delivery.execution.recoveryJobId)` before returning `null` (matching `claim` at `L269-273`), so `recover` (`L371-379`) never misclassifies an unsent email as `uncertain`.
- **`src/convex/emailDeliveries.ts` (`complete` `L325-354`, `recover` `L356-414`):**
  - Add a small helper `isOrphanedContractDelivery(ctx, delivery)`: returns `false` immediately for `delivery.event.kind === 'invitation'`; for `approval`/`decision`, fetches `savedContracts` and checks whether `review.request?.deliveryId === delivery._id` or `(review.completion?.kind === 'queued' && review.completion.deliveryId === delivery._id)`.
  - Run this check **before** scheduling retry or `UNCERTAIN_COOLDOWN` recovery timers in both `complete` and `recover`. Once `!providerDispatchInProgress(delivery)` and orphaned, cancel `recoveryJobId` and `ctx.db.delete('emailDeliveries', delivery._id)` immediately so detached rows never leak or schedule dead timers.

---

### Stage 2 — Compact-Facts Conflict & Invalidation Engine, Zero-Skip Pagination, Unified Geometry & Narrow Overlays

#### 2.1 Use `readValidationFacts` for conflict checking & comment invalidation (0 prose reads on certified templates)
- **`src/lib/playbook/selection-conflicts.ts` (`L20, L39`):**
  - Widen `conflictsForConcession` and `activeConflicts` from `SourceIndex` to `ValidationSourceFacts` (`iterateChangeConflicts` in `src/lib/playbook/conflicts.ts:108` already accepts `ValidationSourceFacts`).
- **`src/convex/templates.ts` (`versionReader` / `snapshotReader`):**
  - Add `readSourceFacts()` on `versionReader`: loads `templateSource` + `readValidationCertificate(ctx, companyId, templateSourceId)`; if `validationCertified(templateSource, certificate)`, returns `(await readValidationFacts(ctx, templateSource, certificate)).index`; otherwise falls back to `buildSourceIndex(await blocks())` (covering the brief window before async `certify` completes when `validation.format === 0`).
- **`src/convex/contractSaving.ts` (`L95-101`):**
  - When `itemsWithChanges.length > 1`, call `const facts = await reader.readSourceFacts()` and pass `facts` to `activeConflicts(facts, overlays, normalizedSelections)` instead of reading full `templateSourceChunks` prose (`reader.blocks()`).
  - Pass `{ itemsById, facts }` into `syncBuyerLink` (`L180`) when loaded.
  - Result: eliminates up-to-8 MiB `templateSourceChunks` prose reads on production multi-concession saves **and** enables `tests/backend/contracts/saving.test.ts` to assert `snapshotBlocks: 0` on real `changes.length > 0` concessions in Stage 4.5.

#### 2.2 Budget-safe, zero-skip `src/convex/discussionInvalidation.ts`
- Remove hardcoded `SYNC_THREAD_LIMIT = 64` / `MESSAGE_BATCH = 64` loops that risk Convex's 16 MiB transaction limit.
- **Accept optional preloaded `{ itemsById?, facts? }` safely:**
  - `deleteAffectedComments` must compute `missingIds = allItemIds.filter((id) => !preloaded?.itemsById?.has(id))` and call `reader.readItemsByIds(missingIds)` for any `prevView.concessions` IDs removed in earlier pending saves before merging with `preloaded.itemsById`.
  - Reuse `preloaded?.facts ?? (await reader.readSourceFacts())` — **0 `templateSourceChunks` prose reads** on certified templates!
- **Never delete messages inline during thread pagination (zero-skip protocol):**
  - In `deleteAffectedComments`:
    1. Initialize `const budget = cleanupBudget(ctx)`.
    2. Check `if (await budget.exhausted())` **before** calling `.paginate(...)`. If already exhausted, schedule `continueDeleteAffected({ contractId, maxContentRevision, changeSet, cursor: null })` and return immediately (0 threads skipped).
    3. Otherwise call `.paginate({ cursor: null, numItems: 16, maximumBytesRead: 2 * 1024 * 1024 })`.
    4. Process **100% of `page.page`** (never break mid-page): for every thread with `thread.contentRevision <= maxContentRevision` whose footprint matches `changeSet`, call `await ctx.db.delete('discussionThreads', thread._id)` synchronously (atomic UI/unread disappearance) and push `thread._id` to `deletedThreadIds`.
    5. After the page loop: if `deletedThreadIds.length > 0`, call `await refreshDirectoryUnread(ctx, contract._id)` once and schedule **one** batched cursorless worker `internal.discussionInvalidation.drainThreadMessages` with `{ threadIds: deletedThreadIds }`.
    6. If `!page.isDone`, safely schedule `continueDeleteAffected` with `cursor: page.continueCursor` (every row in `page.page` was processed).
  - In `continueDeleteAffected`: run the exact same pre-page `budget.exhausted()` check (re-scheduling with the **current** `cursor` if exhausted) → small page `.paginate({ cursor: cursor ?? null, numItems: 16, maximumBytesRead: 2 * 1024 * 1024 })` → 100% page thread deletes → `refreshDirectoryUnread` + batched `drainThreadMessages({ threadIds })` → forward `page.continueCursor` if `!page.isDone`.
  - In `drainThreadMessages({ threadIds: v.array(v.id('discussionThreads')) })`: iterate `threadIds` using `cleanupBudget(ctx).drain('discussionMessages', by_threadId_and_reply)` per thread; if `drain` returns `false` on thread `i`, reschedule `drainThreadMessages({ threadIds: threadIds.slice(i) })`.
  - In `deleteThreadAndMessages(ctx, threadId)` (called from `discussionCommands.ts:212` on single-thread manual delete): delete `threadId` directly without a redundant `ctx.db.get('discussionThreads', threadId)`, drain its messages under `cleanupBudget(ctx).drain(...)`, and schedule `drainThreadMessages({ threadIds: [threadId] })` only if not drained.
- **Fix redundant `contractDirectory` read in `refreshDirectoryUnread` (`L37-41`):**
  - Add an optional `allowMissing = false` parameter to `writeDirectoryUnread` (`src/convex/contractDirectory.ts:47-59`) and remove the redundant `contractDirectory.by_contractId` lookup in `refreshDirectoryUnread`.

#### 2.3 Unify overlap & anchor geometry on `ValidationSourceFacts` + ReDoS-safe `dom-anchor.ts`
- **Eliminate full `planStructuralChanges` dependency from overlap/invalidation:**
  - Both `buildConcessionChangeSet` (`anchors.ts:278-290`) and `filterOverlappedExplanations` (`document-overlay.ts:121,133`) only used `planStructuralChanges` to read `removed` block keys. Per `src/lib/document/structural-changes.ts:188`, the blocks removed by a text change are strictly `targetContainers(index, change.target).slice(replacementParagraphs(change.replacement).length)` — needing **only `ValidationSourceFacts`**, never `SourceBlock[]`.
- **Create shared `src/lib/playbook/overlay-impact.ts` (built on `ValidationSourceFacts` + `src/lib/document/ranges.ts` `targetPosition` / `crossesBoundary`):**
  - Provides pure helpers to collect active/changed concession impacts against `ValidationSourceFacts`:
    - `textRanges` (`{ start, end }` in source coordinates)
    - `removedBlocks` (block keys + doubled ordinals `2 * ordinal`)
    - `insertedBoundaries` (boundary `targetPosition` values AND doubled-ordinal slots `2 * ordinal + 1`)
- **Wire both consumers:**
  1. **`src/lib/playbook/document-overlay.ts` (`filterOverlappedExplanations`, `L100-143`):**
     - Check `removedBlocks`, `textRanges`, **and** boundary insertions via `crossesBoundary(eStart * 2, eEnd * 2, boundaryTargetPosition)` so a multi-paragraph buyer explanation spanning an active rep concession's boundary insertion is properly suppressed.
  2. **`src/lib/discussions/anchors.ts` + `src/lib/discussions/validators.ts`:**
     - Add compact `blockSpan: v.optional(v.object({ start: v.number(), end: v.number() }))` to `discussionFootprint` (`src/lib/discussions/validators.ts:19-29`) using doubled source-block ordinals:
       - Source block at ordinal `k` → coordinate `2 * k`.
       - Concession-inserted paragraph generated after source block `k` (synthetic `insert:...` blockKey) → coordinate `2 * k + 1` (resolved in `extractFootprint` from the part's `run.discussion.origin` / enclosing target or active overlays).
     - Store `insertedBoundaryOrdinals: number[]` (`2 * ordinal + 1`) and `toggledRemovedOrdinals: number[]` (`2 * ordinal`) in `ConcessionChangeSet` and `serializedChangeSet` (`discussionInvalidation.ts:19-24`).
     - In `footprintAffectedByChanges`: check `blockSpan.start < coord && coord < blockSpan.end` for every `insertedBoundaryOrdinals` and `toggledRemovedOrdinals`. This handles empty blocks, tables, previously-removed blocks being restored, and mixed source + concession-inserted paragraph spans in **O(1)** with zero `SourceIndex` reads inside `continueDeleteAffected`.
     - **Zero-length text insertion check (`start === end`):** Verify against `compose.ts` & `anchorPassage` whether a zero-length text insertion sitting exactly on `fStart` or `fEnd` breaks `anchorPassage`/quote resolution or leaves the anchored quote intact; keep strict interior `fStart < start && start < fEnd` unless exact-boundary insertion actually corrupts anchoring.
- **`src/lib/discussions/dom-anchor.ts` (`matchesQuoteWithReferences`, `L157-202`):**
  - Replace the greedy `savedQuote.indexOf(segment, cursor + 1)` loop with a **memoized DP / recursive matcher** (O(N × K), completely immune to V8 regex ReDoS on 20,000-character quotes) requiring ≥1 character for each reference placeholder so repeated separators like `", "` inside reference labels never cause false mismatches or false positives.

#### 2.4 Deduplicate backend `appliedOverlays` while keeping Convex wire schema narrow
- Add a single `readAppliedOverlays(reader, concessions)` helper in `src/convex/templates.ts` (and delete dead `versionReader.selectedItems` at `L582-606`).
- Call it from `src/convex/buyerLinks.ts:487-499`, `src/convex/contractExports.ts:92-104`, and `src/convex/hubspotQuotes.ts:195-207`.
- **Keep `appliedOverlay` (`src/convex/buyerValidators.ts:31-40`) narrow** — do **not** add constant dummy `audience: 'rep'` / `annotations: []` fields to the Convex wire payload.
- Replace the 4× downstream re-wrapping (`wordExportGeneration.ts:23-27`, `hubspotQuoteActions.ts:20-24`, `BuyerDocument.svelte:56-60`, `src/routes/api/buyer/[token]/download/+server.ts:39-43`) via one shared `toAppliedOverlayItems(overlays)` helper in `src/lib/playbook/document-overlay.ts` (or narrow effective-view consumers to accept `AppliedOverlay` directly).

---

### Stage 3 — Fix Client State Machines & Wire Idempotent Discussion Retries

1. **`src/lib/contract/persistence.svelte.ts` (`L305-313`):**
   - On lost-response receipt replay where `result.status === 'saved'` and `olderContractState(result.state, this.confirmed)` is true:
     - Never call `this.acknowledgeRequest(result.state)` (which would regress `baseStateRevision`).
     - Clear `this.request = null` and handle the two exact cases:
       - **User made no additional local edits beyond the replayed save** (`!this.draftSelections || sameSelection(this.draftSelections, concessionSelectionMap(result.state.concessions))`): clear `this.draftSelections = null`, set `this.baseStateRevision = this.confirmed.stateRevision`, `this.resolution = { kind: 'current' }` (cleanly adopting the newer confirmed state).
       - **User made additional local edits on top of the replayed save** (`!sameSelection(this.draftSelections, concessionSelectionMap(result.state.concessions))`): keep `this.draftSelections`, set `this.resolution = { kind: 'conflict' }` (never silently overwrite the teammate's newer revision!).
2. **`src/lib/buyer/contract.svelte.ts` (`L128-152`, `L334-339`, `L407-425`):**
   - Call `this.templateReads.clear()` synchronously inside `release()` before/when aborting `this.lifetime`, eliminating the microtask race where `retry()` → `start()` attaches to an already-aborted promise.
   - Pass `this.lifetime` in `retryDocument()` (`subscribeState(this.generation, this.lifetime)`) so retries are aborted on `release()`/`destroy()`.
3. **`src/lib/discussions/session.svelte.ts` + `src/lib/discussions/delete-confirmation.svelte.ts` + `src/lib/discussions/DiscussionMessage.svelte`:**
   - **Real retry idempotency across all 4 write call sites (`session.svelte.ts:828, 853, 876, 908`):**
     - Store a stable `operationId: string` on `activeComposer` (create, reply, edit) and on `DeleteConfirmationState.current` (`delete-confirmation.svelte.ts`).
     - Reuse the same `operationId` across retry attempts after timeouts or transient network failures.
     - Regenerate `operationId` after completion, when draft text/target changes (`updateComposerText` / target change), **or on definite `ConvexError` / HTTP 4xx rejection** (matching `IdempotentAction`, so a rejected attempt cannot wedge retries on `operationReceipts` input mismatch).
   - **Explicit `deleteMessage` return (`session.svelte.ts:898` + `DiscussionMessage.svelte:129-145`):**
     - Return `{ status: 'ignored' } | { status: 'deleted' } | { status: 'error'; message: string }` instead of `undefined` when blocked by `readOnly || deletingMessageId || activeComposer?.busy`, and handle `'ignored'` in `DiscussionMessage.svelte` without falsely treating it as a successful delete.
   - **Composer vs thread-switch race (`session.svelte.ts:346-356, 830-833`):**
     - Only assign `this.selectedThread = result.threadId` after `submit()` resolves if the user is still viewing `'composer'` (did not navigate away to another thread while busy).
   - **`PaginatedFeed` bounded-window & `SplitRequired` resilience (`session.svelte.ts:75-189`):**
     - Pin completed non-tail pages with `endCursor` (`[cursor, endCursor]`, matching Convex's `usePaginatedQuery` protocol) so page-0 live deletions do not unnecessarily tear down and re-subscribe all subsequent pages, and handle `pageStatus === 'SplitRequired'` + `splitCursor` by splitting a page into two bounded sub-pages in place.
4. **`src/lib/contract/review-controller.svelte.ts` (`L122, L165, L197-199`):**
   - Explicitly check `if (!(await this.options.persistence.savePending())) return;` in `decide` (`L122`), `requestApproval` (`L165`), **and** add it in `resolveCompletion` (`L197-199`) so review completion cannot queue over unsaved/conflicted local edits.
5. **Authoring & UI cleanup:**
   - `src/lib/playbook/authoring-controller.svelte.ts:448-456` + `src/lib/playbook/authoring-context.svelte.ts`: stop coercing whitespace-only input to `{ kind: 'none' }` on every keystroke in `setApprovalGuidance`; preserve raw typed text while editing and normalize via `semanticApprovalPolicy` in `persistedDirty` and `payload` (consistent with `setInstruction`/`setExplanation`).
   - Remove dead `.replace(/downloading/gu, 'pushing to HubSpot')` in `src/lib/components/workspace/RepWorkspace.svelte:664-665`.
   - Remove dead optional fallbacks in `src/lib/components/playbook/RepPlaybookPanel.svelte:31,66` (`approvalPolicy.instructions ?? ''`, `concession.tier ?? 'preferred'`).
   - Remove dead `record.renderKey ?? old?.renderKey` fallback in `src/lib/playbook/template-authoring-session.svelte.ts:436`.

---

### Stage 4 — Zero-Backwards-Compat Structural Simplification

#### 4.1 Collapse `contractCreationReceipts` into `operationReceipts`
- Update `src/convex/contracts.ts` (`create`, `L180-224`) to store contract-creation receipts in `operationReceipts` (`actionKey(access, 'create', args.operationId)`, `result = contract.root._id`, matching `src/convex/hubspotDeals.ts:110-128,222`), replaying `{ status: 'created', ... }` if the contract exists or `{ status: 'deleted' }` if deleted.
- Delete `contractCreationReceipts` from `src/convex/schema.ts`, remove its prune loop from `src/convex/operationReceipts.ts:90-96`, and remove `'contractReceipts'` from `src/convex/deletionValidators.ts:42` and `src/convex/companyDeletion.ts:389-396`.
- **Keep 24h TTL retention (no `by_contractId` index / no `contractCleanup` drain):** Document the accurate invariant in code and docs — `contracts.create`, `hubspotDeals`, and `hubspotQuotes` check `operationReceipts` before contract existence (whereas `contracts.save`, `approvals.*`, `buyerLinks.capture`, and `discussions.*` check existence first), and all receipts self-expire in 24h via `operationReceipts.pruneExpired` and are wiped on `companyDeletion`.

#### 4.2 Delete legacy authoring migration & formatting-repair scaffolding
- Delete `src/convex/authoringMigration.ts` and `src/convex/templateSourceFormatting.ts`.
- Remove `analyzeExisting` (and its unused imports) from `src/convex/templateSourceParser.ts:1-59`; **keep** `prepare` (`L61-101`, live via `src/convex/templateUploads.ts:415`).
- Delete legacy operator scripts `scripts/migrate-authoring.mjs`, `scripts/template-source-roles.mjs`, and `scripts/paragraph-role-transition.mjs`, and remove their references from `scripts/operator-types.ts:7-15` and `scripts/company-convex.mjs:23-28,69,95-117` (required for `npm run check:tools`).
- Remove `authoringMigrations` table and `company.authoringMigration` field from `src/convex/schema.ts`, remove `'authoringMigrations'` from `src/convex/deletionValidators.ts:38`, and remove all `company.authoringMigration` guards from:
  - `src/convex/templates.ts`
  - `src/convex/playbookItems.ts`
  - `src/convex/authoringValidation.ts`
  - `src/convex/companyDeletion.ts`
- Tighten `templateVersions.validation` in `src/convex/schema.ts:318` from `v.optional(...)` to **required**:
  `v.object({ format: v.union(v.literal(0), v.literal(VALIDATION_CODEC_VERSION)), fingerprint: v.string() })`
  - Refactor `TemplateVersionContent`, `writeTemplateVersion`, and `saveChangedVersion` in `src/convex/templates.ts:202-205,313-322,446-467` so `validation` is always supplied unconditionally (`{ format: 0, fingerprint }` in `saveTemplateVersion`; `{ format: VALIDATION_CODEC_VERSION, fingerprint }` in `saveChangedVersion` since `readAuthoringVersion` already guarantees certification).
  - Update raw test fixtures (`tests/backend/contracts/saving.test.ts:65-79`) to supply `validation` and a certified `templateSourceCertificates` + `templateSourceValidationChunks` pair.

#### 4.3 Rewrite `src/convex/companyDeletion.ts` cleanly (~618 LOC → ~200 LOC)
- Delete the entire pre-nuke rolling-deploy fallback block in `case 'company'` (`L496-597`), eliminating 4× `cleanupCompanyExports`, 3× `contractCleanups`, 2× `hubspotLinkBlocks`, and the missing `cancelJob(ctx, row.recoveryJobId)` bug on `csmBookingAttempts` (`L563-566`).
- Replace the verbose switch with a clean declarative ordered phase list, keeping `src/convex/deletionValidators.ts` (`companyCleanupPhases`) in 1:1 sync while preserving the exact real barriers:
  1. Retire HubSpot credentials/Workpool work & wait for started HubSpot/email actions (`retireCompanyHubSpot`, `emailDeliveries`).
  2. Drain every remaining company-scoped child table once each under `cleanupBudget(ctx)` (canceling all scheduled jobs, resetting quotas, deleting unowned `_storage` files via `deleteUnownedFile`).
  3. Delete `company` (and unowned `company.avatarId`) last, retaining only the permanent `companyDeletions` tombstone (`status: 'complete'`).
- **Mandatory completeness audit (no existing end-to-end automated test covers `companyDeletion.clean`):** Cross-check every table in `src/convex/schema.ts` against the new phase list + `retireCompanyHubSpot` so 100% of company-scoped tables are accounted for (explicitly verifying the only excluded tables are global/user-scoped: `profiles`, `deletedUsers`, `companyDeletions`, `fileSweeps`, `hubspotJournal`, `hubspotPortalLifecycle`, `hubspotAccountRemovals`).

#### 4.4 Eliminate redundant per-mutation DB queries across backend helpers
- **`src/convex/discussionContext.ts`, `src/convex/discussions.ts`, `src/convex/discussionService.ts`:**
  - Pass verified `access` into `discussionActor` instead of calling `requireMembership` and `memberForCompany` 2–3× per query/mutation.
  - Remove the duplicate `contractCleanups.by_contractId` lookup in `discussionContext.ts:22-26` (`resolveView` in `buyerLinks.ts:163-167` already checked it).
  - Drop `readContract` (and its `contractHubspotAssociations` lookup) from `discussionContext.ts:27` — discussions only need `savedContracts` (`root`), never `hubspot`.
- **`src/convex/hubspotQuotes.ts` (`L160-174`, `L239-260`):**
  - Remove the redundant `requireMembership` call immediately preceding `seller(ctx, args)` in both `prepare` and `commit`.
- **`src/convex/hubspotDeals.ts` (`L212-221`) & `src/convex/contracts.ts` (`L334`):**
  - Call `requestBuyerRefresh` once per deal-linked contract creation, not in both `createContract` and `hubspotDeals.commit`.
- **`src/convex/playbookItems.ts` (`L270-335`), `src/convex/playbookItemRevisions.ts` (`L201-241`), & `src/convex/templates.ts` (`L213-223`):**
  - Pass optional `mutableVersionId` into `createAuthoringItem` → `storeItemRevision` so creating a new item on an already-mutable version writes `mutableVersionId` directly (eliminating `markDraftItemRevision` + `addTemplateReadBytes`; simplify `playbookItems.ts:332` to `if (!mutableVersionId)`).
  - Remove the unused `pointer` parameter from `templateGenerations` (`src/convex/templates.ts:213-223`).

#### 4.5 Tighten remaining loose validators, enforce non-empty concessions, & delete dead remnants
- Make `expectedStateRevision` **required** (`v.number()`) in:
  - `src/convex/exportValidators.ts:7`
  - `src/convex/hubspotQuoteValidators.ts:13`
  - `src/convex/buyerLinks.ts:317,454`
- Remove unused optional `workBlock: v.optional(workBlock)` from `contractState` in `src/convex/savedContractValidators.ts:25` (keeping required `workBlock` on `liveContractMetadata`).
- **Enforce real non-empty concessions without weakening `saving.test.ts`:**
  - Update the 3 synthetic test fixtures (`tests/support/contract-data.ts`, `tests/support/document.ts`, `tests/components/contracts/fixtures.ts`) and `tests/backend/contracts/saving.test.ts:50-79` to use **real, non-overlapping `changes.length === 1` concessions** (`first` and `second` targeting distinct ranges of `text-1`) plus a certified `templateSourceCertificates` + `templateSourceValidationChunks` pair (backed by Stage 2.1's `readValidationFacts` conflict check so `saving.test.ts:229-268` now proves `snapshotBlocks: 0` on *real* multi-concession saves!).
  - Enforce non-blank `concession.description` (`!concession.description.trim()`) and `concession.changes.length > 0` in `src/lib/playbook/validation.ts:132-137`.
- Align `src/lib/contract/persisted-values.ts:212-259` with `validateTemplateItemContent`: reject blank present instruction strings (`!text.trim()`), reject blank concession descriptions / empty `changes`, and delete the duplicate `sourceTarget(value.trigger.target)` check at `L241`.
- Delete dead materialized-doc alias remnants: `baseAliases` in `src/lib/document/compose.ts:108` and `aliases` in `src/lib/document/source-index.ts:46`.

---

### Stage 5 — Sync Cache Namespace, Codegen, Formatting, Full Doc Parity & Final Verification

1. **Bump client browser cache namespace:**
   - Update `src/lib/contract/browser-storage.ts:14` from `dinu:v8` to `dinu:v9` so clients cleanly discard pre-refactor local cache entries.
   - *(Optional eager-eviction hygiene: bump `dinu:workspace-read:v1` → `v2` in `src/lib/auth/workspace-read-storage.ts:45`; not a crash risk because `validTemplate` already validates and auto-evicts stale `templateDetails` on read.)*
2. **Regenerate Convex types:**
   - Run `npx convex codegen` (unsandboxed if needed) so `src/convex/_generated/api.d.ts` and `dataModel.d.ts` reflect the exact final schema and modules (no `contractCreationReceipts`, no `authoringMigrations`, no `authoringMigration` / `templateSourceFormatting`, no `templateSourceParser.analyzeExisting`).
3. **Format all modified files:**
   - Run `npx prettier --write` across all edited `src/` and `scripts/` files.
4. **Bring all living docs into 100% parity with final code:**
   - `docs/data-model.md`: update exact table count (`49` tables), fix `discussionThreads.footprint` schema (including `blockSpan`), document `stateRevision` vs `metadataRevision`, accurate `operationReceipts` post-delete rationale, `dinu:v9`, and removal of `contractCreationReceipts` / `authoringMigrations`.
   - `docs/email-delivery.md`: remove stale `L7` delivery-snapshot paragraph; document `expectedDecidedAt` on `approvals.complete`.
   - `docs/hubspot.md`: remove stale references to `"late acknowledgments"`, `"reserved download attempts"`, `"output evidence"`, `"document revisions"`, and `"review context tokens"`; **keep `"dinu:drafts:v7"`** (`L91`, still live!); update `gated()` docs (`L155`) to reflect `title` + `stateRevision`.
   - `docs/retention.md:9`: remove `contractCreationReceipts`.
   - `docs/deployment.md:141,147`: remove `authoringMigrations` / `authoringMigration:begin`.
   - `docs/template-authoring-storage.md:182,265`: remove `authoringMigration` section and fix `IndexedDB schema 2` → `3` (matching `workspace-read-storage.ts:332`).
   - `docs/template-storage.md:94,98`: remove `authoringMigration.begin/step/finish`; document `expectedTitle` and `readValidationFacts` conflict checks.
   - `docs/document-formatting.md:110`: remove `templateSourceFormatting`.
   - `docs/company-deletion.md`: sync with rewritten declarative `companyDeletion.ts` and removed phases.
   - `README.md:124-141`: remove stale `"emailSelectionChunks"`, `"concession details"` in approval requests, and `"remove associated snapshots"`; verify `?review=1` URL claim.
5. **Run full automated verification (no redundant reruns):**
   - `npm run verify` (runs `test:ssr`, `test:backend` including HubSpot & exports, `test:client`, `test:components`, `test:perf`, `svelte-check`, `check:tools`, `vite build`, and `verify:loading-bundles`)
   - `npx tsc --noEmit -p src/convex/tsconfig.json` *(explicitly required — not included in `npm run verify`)*
   - `npm run seed:verify`
   - `npx prettier --check` on all modified `src/` and `scripts/` files
6. **Report clearly:**
   - List every automated check executed and passed, and explicitly call out everything unverified by automation (e.g., `companyDeletion.clean`, `approvals.*`, `retractBuyerLinkConcession`, `discussionInvalidation`, `DiscussionSession` retries/pagination, live HubSpot/Loops/Clerk/Cal integrations, real browser interactions, and clean DB reset/re-seed on dev deployment).
