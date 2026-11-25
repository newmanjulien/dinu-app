# Critique of `end-state-cleanup-plan.md`

**Target reviewed:** [end-state-cleanup-plan.md](end-state-cleanup-plan.md)  
**Verified against:** Current working tree (`src/convex/`, `src/lib/`, `scripts/`, `tests/`, `docs/`, `package.json`) and both handoff reports ([playbook-only-refactor-handoff.md](playbook-only-refactor-handoff.md), [template-authoring-toolbar-simplification-handoff.md](template-authoring-toolbar-simplification-handoff.md)).

## Executive Summary

**Overall verdict:** Strong **diagnosis** and unusually disciplined **architecture framing**, paired with several **concrete bugs, missed call sites, and broken mechanics in the proposed implementations**.

The plan accurately identifies real correctness, concurrency, and Convex-limit defects introduced or exposed by the two uncommitted refactors, and its "Intentional Complexity — Do NOT Break or Remove" guardrails (§3) are genuinely load-bearing. However, executing Stages 1–5 literally as written would:
- **permanently skip comment invalidations** under Convex pagination + `cleanupBudget` (Stage 2.1),
- **break both Convex compilation and `npm run check:tools`** when deleting `templateSourceFormatting.ts` / `authoringMigration.ts` (Stage 4.2),
- **introduce a silent last-write-wins overwrite bug** in `ContractPersistence` on lost-response replay (Stage 3),
- **break `tests/backend/contracts/saving.test.ts` (a `test:perf` guarantee)** by disallowing `changes: []` without reconciling the 2-selection zero-block-read assertion (Stage 4.5), and
- **leave `stateRevision` semantics leaky** across `hubspotDeals.commit`, `hubspotQuotes.gated`, and equal-revision client cache ordering (Stage 1.1).

---

## Strengths

### 1. Grounded in Verified, High-Severity Real Bugs
Almost every defect targeted in Stages 1–4 is real and verified in the current tree rather than speculative polish:
- **Background `stateRevision` corruption:** `src/convex/hubspotRecipients.ts:186,207` genuinely increments `stateRevision` on background HubSpot company-name refreshes, which can trigger false conflicts in `ContractPersistence.accept()` (`src/lib/contract/persistence.svelte.ts:196`) and abort queued quote pushes (`src/convex/hubspotQuotes.ts:107`).
- **Real email & approval state-machine bugs:**
  - `src/convex/emailDeliveries.ts:300` (`beginDispatch`) returns `null` when `!to` without marking the row `skipped` or canceling `recoveryJobId`, causing `recover` (`L371-379`) to misclassify an unsent email as `uncertain`.
  - `src/convex/approvals.ts:185-238` (`request`) falls through on a `skipped` delivery (`deliveryStatusOf` returns `null` at `src/convex/contracts.ts:69`) and emits a duplicate HubSpot `'requested'` activity.
  - `src/convex/approvals.ts:308-395` (`complete`) has no freshness check beyond `expectedGeneration`, so a concurrent `approved ↔ rejected` flip lets a stale modal email updated counts.
- **Real Convex 16 MiB transaction hazard:** `src/convex/discussionInvalidation.ts:16-17,44-54,125-137` can synchronously read up to `64 × 64 = 4,096` messages inside `contracts.save` / `approvals.decide`.
- **Real client state-machine defects:**
  - `src/lib/contract/persistence.svelte.ts:305-312` calls `acknowledgeRequest(result.state)` even when `olderContractState(result.state, this.confirmed)` is true, regressing `baseStateRevision`.
  - `src/lib/buyer/contract.svelte.ts:128-152,338,407-425` has the `release()`/`retry()` `templateReads` microtask race and omits `this.lifetime` in `retryDocument()`.
  - `src/lib/discussions/session.svelte.ts:828,853,876,908` mints fresh UUIDs per click (defeating backend `operationReceipts`), returns `undefined` on guarded `deleteMessage` (`L898`, treated as success by `src/lib/discussions/DiscussionMessage.svelte:133-136`), and steals `selectedThread` when `submit()` finishes (`L832`).
  - `src/lib/contract/review-controller.svelte.ts:122,165` ignores the boolean return value of `savePending()`.
  - `src/lib/playbook/authoring-controller.svelte.ts:448-456` (`setApprovalGuidance`) clobbers whitespace on every keystroke.
- **Real redundant DB queries & cleanup bugs:** Duplicate `buyerLinks` revocation (`contracts.ts:283-288` vs `contractCleanup.ts:54-56`), missing `currentView !== null` in `accounts.ts:205-212`, duplicate `contractCleanups` & unnecessary `readContract` in `discussionContext.ts:22-27`, duplicate `requireMembership` in `hubspotQuotes.ts:160,174,239,260`, double `requestBuyerRefresh` in `contracts.ts:334` + `hubspotDeals.ts:221`, and `companyDeletion.ts:496-597` rolling-deploy bloat + missing `cancelJob(ctx, row.recoveryJobId)` at `L563-566`.
- **Real geometry & quote-matching gaps:** Intermediate empty/table/removed blocks in `src/lib/discussions/anchors.ts:305-309`, missing boundary-insertion checks in `src/lib/playbook/document-overlay.ts:100-143`, and greedy `indexOf` in `src/lib/discussions/dom-anchor.ts:197`.

### 2. High-Value "Intentional Complexity" Guardrails (§3)
Explicitly enumerating 12 non-obvious invariants before cleanup is one of the plan's best design choices. Every listed constraint checks out against the code (e.g., optional `itemHeadFields.currentRevisionId` for the 2-step atomic insert in `createAuthoringItem`, `savedContracts.lastOperation` for passive lost-response reconciliation, `hubspotQuotes.commit`'s 2-pass `payload-required` flow, `wordExports` split download TTL vs physical grace, dual `$derived` validators in `AuthoringContext`, `contractCleanup.ts`'s single-`.paginate()`-per-mutation split, and buyer download's fresh second `ConvexHttpClient`). This sharply lowers the risk of an over-zealous cleanup introducing subtle regressions.

### 3. Sensible Stage-0-First Ordering & Explicit Locked Decisions (§1, §4)
- Refusing to layer more changes on top of unverified Pass 2 edits (`SIGKILL` / exit 137) and stale `data/convex/playbookItems.jsonl` (which currently contains blank `""` instruction keys that fail `src/lib/playbook/validation.ts:138-144`) is the right sequencing.
- Locking the three genuinely ambiguous product/schema calls up front (targeted retraction on admin revoke, `stateRevision` ownership, deleting migration modules) aligns cleanly with `AGENTS.md`'s zero-backwards-compatibility rule.

---

## Weaknesses

### A. Concrete Bugs & Broken Mechanics in Proposed Fixes

#### 1. Stage 2.1 (`discussionInvalidation.ts`): Breaking mid-page on `cleanupBudget` + forwarding `page.continueCursor` permanently skips threads
- **Plan says (`L133-137`):** Paginate `discussionThreads` with `.paginate(...)`, check `budget.exhausted()` before every thread and every message batch, and when stopping due to budget, schedule `continueDeleteAffected` with the actual `page.continueCursor`.
- **Why this breaks:** Convex's `page.continueCursor` always points **past the entire fetched page**, not at the index where the loop broke. If `.paginate({ numItems: 32 })` returns 32 threads and `budget.exhausted()` triggers on thread #3, scheduling `continueDeleteAffected` with `page.continueCursor` **permanently skips threads #4–#32**, leaving invalidated comments live on the buyer link forever.
- **Compounding issue:** `deleteAffectedComments` runs inside `contracts.save` and `approvals.decide`. `cleanupBudget(ctx)` trips when `bytesRead.remaining < 4_000_000` (`src/convex/cleanup.ts:15`). On a large template (~12–15 MiB of blocks), `budget.exhausted()` can trip immediately after fetching page 1 — skipping the entire first page if `continueCursor` is forwarded.
- **How to fix:** Never break mid-page and advance to `continueCursor`. Either:
  1. Check `budget.exhausted()` **before** calling `.paginate()` with a small bounded page (e.g., `numItems: 8–10` with `maximumBytesRead`) and **always finish processing every thread row on the fetched page** — deleting thread rows synchronously and deferring message deletion to `drainThreadMessages` whenever remaining budget is tight; or
  2. Use explicit continuation state for unprocessed `threadIds` on the current page before advancing to `page.continueCursor` (and keep `drainThreadMessages` cursorless using `budget.drain` / `take` from the front).

#### 2. Stage 4.2 (Deleting `authoringMigration.ts` + `templateSourceFormatting.ts`): Misses live callers and breaks both Convex build and `npm run check:tools`
- **Plan lists (`L27, L196-203`):** Deleting both files, `authoringMigrations`, `company.authoringMigration`, and updating `templates.ts`, `playbookItems.ts`, `authoringValidation.ts`, and `companyDeletion.ts`.
- **Missed callers that will fail compilation immediately:**
  1. **`src/convex/templateSourceParser.ts:30`** calls `internal.templateSourceFormatting.inspectSource` inside `analyzeExisting` (and imports `documentSource` from `src/lib/document/paragraph-migration.ts`). Note that `templateSourceParser.prepare` (`L61-101`) **is live** (called by `src/convex/templateUploads.ts:415`), so only `analyzeExisting` should be removed — not the whole module.
  2. **`scripts/operator-types.ts:7-15`** imports types for `internal.authoringMigration.{begin,step,finish}`, `internal.templateSourceFormatting.*`, and `internal.templateSourceParser.analyzeExisting`. Because `npm run check` runs `npm run check:tools` (`tsc --project tsconfig.tools.json`), deleting the Convex modules without updating/deleting `scripts/operator-types.ts`, `scripts/migrate-authoring.mjs`, `scripts/template-source-roles.mjs`, and `scripts/company-convex.mjs:97-113` breaks `npm run verify`.
  3. **`src/convex/deletionValidators.ts:38,42`** enumerates `'authoringMigrations'` and `'contractReceipts'` in `companyCleanupPhases` (also needed for Stage 4.1 / 4.3).
  4. **`src/convex/templates.ts:450-464` (`saveChangedVersion`):** Making `templateVersions.validation` required in `schema.ts` breaks `saveChangedVersion`, which passes a `TemplateVersionContent` omitting `validation` and relies on `writeTemplateVersion` (`L317-321`) to conditionally attach it. `TemplateVersionContent` / `saveChangedVersion` / `writeTemplateVersion` must be refactored to supply `validation` unconditionally (since `readAuthoringVersion` already guarantees certification and `saveTemplateVersion` supplies `format: 0`).

#### 3. Stage 3 (`persistence.svelte.ts:305-312`): Literally preserving `baseStateRevision >= confirmed.stateRevision` introduces a silent data-loss bug
- **Plan says (`L169`):** On lost-response receipt replay when `olderContractState(result.state, this.confirmed)` is true, do not call `acknowledgeRequest(result.state)`; clear/resolve the in-flight request while preserving `this.baseStateRevision >= this.confirmed.stateRevision`.
- **Why this causes silent overwrites:** Suppose User A saved Save A (`{ item1: X }`, rev 7 → 8), the response was lost, and Teammate B saved rev 9 (`{ item1: Y }`). User A still has `draftSelections = { item1: X }` (or made another edit `{ item1: X, item2: Z }` on top of Save A).
  - If you simply clear `this.request = null` and set `baseStateRevision = 9` while leaving `draftSelections` non-null and `resolution = { kind: 'current' }`, the `finally` block (`L338`) immediately calls `this.start()` and **silently overwrites Teammate B's rev 9 with User A's stale draft**!
- **Correct resolution has two distinct sub-cases:**
  - If `this.draftSelections` still equals the replayed Save A (`sameSelection(this.draftSelections, concessionSelectionMap(result.state.concessions))`), Save A succeeded and was cleanly superseded by rev 9 → clear `this.draftSelections = null`, set `this.baseStateRevision = this.confirmed.stateRevision`, `this.resolution = { kind: 'current' }`.
  - If the user made *additional* local edits beyond Save A (`!sameSelection(this.draftSelections, rev8)`), those edits were based on rev 8, not rev 9 → keep `this.draftSelections`, set `this.resolution = { kind: 'conflict' }` (do **not** silently bump `baseStateRevision` to 9 and auto-submit!).

#### 4. Stage 4.5 (Enforcing `concession.changes.length > 0`): Breaks `tests/backend/contracts/saving.test.ts` (a `test:perf` guarantee)
- **Plan says (`L236`):** *"Fix the 3 synthetic test fixtures that use `changes: []` on concessions, then enforce non-blank `concession.description` and `concession.changes.length > 0` in `src/lib/playbook/validation.ts:132-137`."*
- **Why this collides with `saving.test.ts`:**
  - `tests/backend/contracts/saving.test.ts:50-56,229-268` creates **two** items (`first`, `second`) from the shared `item` fixture in `tests/support/contract-data.ts` (both targeting `text-1` `[0, 9)`).
  - The perf test *"saves two, zero and one selections without frozen-source reads or compilation"* (`L229`) explicitly asserts **`snapshotBlocks: 0`** when saving **two** selections (`choices = { [first]: 'preferred', [second]: 'preferred' }`).
  - In `src/convex/contractSaving.ts:95`, `if (itemsWithChanges.length > 1)` reads `templateSourceChunks` (`snapshotBlocks: 1`) and runs `activeConflicts(...)`.
  - Therefore, replacing `changes: []` in `tests/support/contract-data.ts` with a real change causes TWO immediate failures in `saving.test.ts`:
    1. Both `first` and `second` collide on `[0, 9)` and throw `'Selected concessions conflict with each other.'`.
    2. Even with distinct non-overlapping ranges, saving 2 selections with real changes increments `snapshotBlocks` from `0` to `1`, breaking the `test:perf` assertion (which `AGENTS.md` forbids weakening merely to pass!).
- **Missing decision:** Either `contractSaving.ts` must evaluate conflicts without reading full blocks (e.g., via certified validation facts) to preserve the 0-block-read guarantee for 2+ edits, OR the perf test guarantee itself must be explicitly updated to reflect that 0/1 selections read 0 blocks while 2+ edits must read blocks for conflict detection.

#### 5. Stage 1.1 (`savedAt` same-millisecond `directoryWrites` flake): The second `"OR"` option does not work
- **Plan says (`L95`):** *"ensure `savedAt` is monotonic (`Math.max(now, contract.root.savedAt + 1)`) **OR** trigger `writeDirectory` on `'stateRevision' in rootChanges` when `savedAt` is updated, while keeping `writeDirectory` idempotent when nothing in the directory projection changed."*
- **Why the `"OR"` option fails:** `contractDirectory` (`src/convex/contractDirectory.ts:24-43`) does **not** store `stateRevision`, and `writeDirectory` skips `ctx.db.replace` when all directory fields match `row`. If two saves land in the same millisecond (`now === contract.root.savedAt`), `savedAt` is unchanged, every projected column matches, `writeDirectory` still performs 0 writes, and `saving.test.ts:258` (`directoryWrites: 1`) still flakes.
- **Fix:** Drop the `"OR"` and commit strictly to monotonic `savedAt = Math.max(now, contract.root.savedAt + 1)` (also apply in `contracts.rename` for consistency).

#### 6. Stage 2.2 (`dom-anchor.ts` regex + `serializedChangeSet` + boundary insertions): Hidden ReDoS and serialization traps
- **ReDoS hazard (`L154`):** Recommending an *"escaped regex with `.+` for each reference placeholder"* on quotes up to 20,000 chars (`anchors.ts:24`) invites catastrophic backtracking in V8 when multiple references share common separators (e.g., `", "`) and a match fails near the end. Use only the memoized DP / bounded backtracking approach — drop the regex suggestion.
- **Broken async invalidation contract (`L146-150`):** `continueDeleteAffected` (`src/convex/discussionInvalidation.ts:154-191`) does **not** load `blocks` or `SourceIndex` — it only receives `serializedChangeSet` (`removedConcessions`, `textRanges`, `insertedAfterBlocks`, `removedBlocks`). Checking block-order range between `footprint.blockKeys[0]` and `footprint.blockKeys.at(-1)` requires block ordinals, which neither `thread.footprint` nor `serializedChangeSet` currently contains. Additionally, concession-inserted paragraphs have synthetic `blockKey`s absent from `index.blockOrdinals`, which must be handled explicitly so comments starting/ending in inserted paragraphs don't crash or silently skip checks.
- **Unverified zero-length boundary semantics (`L150`):** Changing `start === end` from strict interior `fStart < start && start < fEnd` to `<=` risks over-invalidating comments strictly adjacent to (not containing) an insertion, where `anchorPassage` still resolves identically. This should be verified against `compose.ts` / `anchorPassage` before changing.

---

### B. Architectural Contradictions, Incomplete Designs & Missed Call Sites

#### 7. Stage 1.1 (`stateRevision` semantics): Misses `hubspotDeals.ts:208`, creates equal-revision cache clobbering, and hedges on `hubspotQuotes.gated`
- **Missed `stateRevision` bump:** `src/convex/hubspotDeals.ts:208` (relinking a contract to a new HubSpot deal) still sets `stateRevision: current.root.stateRevision + 1`, violating the locked invariant (*"`stateRevision` tracks concessions and review state only"*) and contradicting `docs/hubspot.md:17` (*"preserving content, edit/review revisions and directory order"*).
- **Equal-revision cache/state clobbering on rename:** The plan claims (`L25`) that removing `stateRevision` bumps from `contracts.rename` works seamlessly because `olderContractState` uses strict `<`. That only explains why a *newer* rename isn't rejected; it ignores the inverse problem: `olderContractState` is also the sole freshness guard in `ContractPersistence.send()` (`persistence.svelte.ts:305`), `SnapshotCache.updateState()` (`snapshot-cache.ts:509`), `SnapshotStorage` (`snapshot-storage.ts:250,351,358`), and `ContractEditors` (`editors.svelte.ts:136,254`). If a contract is renamed at rev 5 (`"Old"` → `"New"`) while a rev 5 save reply or delayed IDB/snapshot read returns `{ stateRevision: 5, title: "Old" }`, `5 < 5` is `false` and **the stale `"Old"` title overwrites `"New"`**. Ordering equal-revision updates requires comparing `savedAt` (monotonic) or a dedicated metadata clock when `stateRevision` ties.
- **Unresolved `hubspotQuotes.gated()` product behavior & wrong file paths:**
  - Leaving `gated()` as *"and optionally `gated`"* (`L93`) glosses over a real behavior change: `title` is hashed into `fingerprint`/`canonicalKey` (`src/lib/document/export/quote-identity.ts:19`) and sent as `hs_title` (`src/convex/hubspotQuoteActions.ts:129`). Without checking `root.title !== row.title` in `gated()`, renaming a contract while a quote push is `queued` will dispatch a quote with the **old** title (previously aborted by `stateRevision`). Decide explicitly instead of leaving it optional.
  - File names are slightly wrong in `L92-93`: `expectedTitle` is captured from `prepared.title` inside `src/convex/wordExportGeneration.ts` (not `src/convex/wordExport.ts`, which is a 16-line wrapper) and `src/convex/hubspotQuoteActions.ts`. Neither `exportValidators.ts` (`wordExportRequest`) nor `hubspotQuoteValidators.ts` (`quoteRequest`) needs `expectedTitle` unless the client is also expected to pass it into `prepare` (which the plan never specifies).

#### 8. Stage 1.2 & 2.1 (`retractBuyerLinkConcession` & preloaded items): Subtle data-mismatch traps
- **`preloaded.itemsById` cannot cover `prevView.concessions`:** Both `saveSelections` (`contractSaving.ts:75-80`) and `approvals.decide` (`approvals.ts:69-72`) only hydrate items currently in `contract.root.concessions` (plus just-removed items when a review exists). When a buyer link is held back across multiple pending saves before syncing, `link.currentView.concessions` (`prevView`) can contain `itemId`s that were removed in an *earlier* save and are **absent from `preloaded.itemsById`**. `deleteAffectedComments` must fetch any `allItemIds` missing from `preloaded.itemsById` (and only skip `reader.blocks()` when `preloaded.blocks` was actually loaded, since `approvals.decide` never loads blocks and `saveSelections` only loads them when `itemsWithChanges.length > 1`).
- **Retraction option mismatch:** `retractBuyerLinkConcession` (`L100-105`) removes `itemId` from `link.currentView.concessions` without checking whether `link.currentView.concessions[itemId]` matches the revoked `expectedOptionId` (e.g., if `optionA` was live, rep switched to `optionB`, admin approved `optionB` while another item was pending, then admin revoked `optionB`). Retracting `itemId` unconditionally is likely the safer policy, but it should be stated explicitly.
- **Second `linkFor` call in `accounts.ts:211`:** `readSetupProgress` checks both `by_companyId_and_creatorId` (`L205-210`) **and** `linkFor(ctx, contract.contractId)` (`L211`); both must check `currentView !== null`.

#### 9. Stage 1.3 (Approvals & `emailDeliveries`): Missed invariants in all three bullets
- **`approvals.complete` contract conflict (`L117`):** `approvals.complete` currently returns `{ status: 'skipped' }` (not a thrown `ConvexError`) on stale generation (`approvals.ts:333-351`, `docs/email-delivery.md:48`), and `ContractReviewController` expects silent dismissal on `skipped` vs an error banner on `ConvexError`. Changing mismatch handling to throw `ConvexError` needs deliberate alignment with the UI modal UX, an update to `ContractReviewController.reconcile()` (`src/lib/contract/review-controller.svelte.ts:95-102`, which currently only clears `completionAttempt` on `generation` change, not `decidedAt`!), and an update to `tests/backend/hubspot/activity.test.ts:128`.
- **`approvals.request` `'skipped'` restart trap (`L119`):** `restartDelivery` (`emailDeliveries.ts:503-514`) explicitly rejects `state.kind === 'skipped'`. Worse, reusing the old skipped row via `restartDelivery` would reuse the old `delivery.event.recipientEmail` — if the delivery was skipped because the company's `approvalEmail` was invalid/changed, restarting the old row would keep the stale email! Creating a fresh delivery with the current `recipientEmail` (while skipping the duplicate HubSpot `'requested'` activity when `existing.generation === review.generation`) is cleaner and avoids stale-recipient bugs.
- **Orphaned `emailDeliveries` cleanup (`L123`):**
  - Must ignore `event.kind === 'invitation'` (which has no `contractId` and is referenced by `companyInvitations.deliveryId`, not `savedContracts`).
  - Must check detachment **before** `complete` (`L340-351`) and `recover` (`L392-411`) schedule follow-up retries or 10-minute `uncertain` cooldown timers — otherwise a detached `uncertain` approval delivery still schedules dead recovery jobs before ever settling.

#### 10. Stage 2.3 (`readAppliedOverlays` returning full `DocumentOverlayItem`): Pollutes Convex wire schemas
- Adding constant dummy fields (`audience: 'rep'`, `annotations: []`) to `appliedOverlay` (`src/convex/buyerValidators.ts:31-40`) bloats every reactive `buyerLinks.currentState` WebSocket payload and query→action boundary just to eliminate four tiny downstream `.map()` calls.
- **Better end state:** Keep the Convex wire shape narrow (deduplicate the 3 backend projections into `readAppliedOverlays` and delete dead `versionReader.selectedItems`), and either narrow `composeExport`/`createDocumentWorkspace`/`filterOverlappedExplanations` to accept `AppliedOverlay` (none of those effective-view consumers need `annotations` or `audience`) or share one 4-line adapter in `src/lib/playbook/document-overlay.ts`.

#### 11. Stage 3 (`DiscussionSession` retries & `PaginatedFeed`): Under-specified error/cursor mechanics
- **Missing `ConvexError` rotation & delete-confirmation ownership (`L174`):** Unlike `IdempotentAction`, the plan doesn't specify clearing/rotating `operationId` on definite `ConvexError` (e.g., stale `contentRevision` or `expectedRevision`), nor does it mention `src/lib/discussions/delete-confirmation.svelte.ts` / `DiscussionMessage.svelte`, where pending delete retries actually live.
- **Under-specified `PaginatedFeed` fix (`L177`):** Saying *"handle Convex `splitCursor` / `isDone` transitions without unnecessarily dropping and re-subscribing all tail pages on cursor shift"* omits the key mechanism: Convex reactive pagination requires bounded `[cursor, endCursor]` page windows (like `usePaginatedQuery`) plus `pageStatus === 'SplitRequired'` splitting into two sub-ranges. Without specifying that protocol, an implementer can easily introduce duplicate or dropped threads across page boundaries.

#### 12. Stage 4.1 (`operationReceipts` + single-contract delete): Leaves an unresolved hedge
- Line 193 says *"either document clearly which namespaces rely on post-delete replay ... or add `by_contractId` cleanup for contract-local mutation receipts"*.
- `playbook-only-refactor-handoff.md:175` already established why `operationReceipts` has no `by_contractId` index: single-contract deletion must preserve in-flight replay fences (`save`, `quote`, `create`), and rows already self-expire in 24h. The plan should commit to documenting 24h TTL retention rather than leaving an "either/or" branch open.

---

### C. Operational, Tooling, Cache & Verification Blind Spots

1. **Zero git commits across ~400 modified files:** Both prior refactors remain completely uncommitted on top of `HEAD`. Running 5 more sweeping stages without creating a checkpoint commit after Stage 0 goes green makes isolating regressions or bisecting diffs far harder than necessary.
2. **`npx convex codegen` offline failure unhandled (Stage 0 `L78`, Stage 5 `L247`):** `template-authoring-toolbar-simplification-handoff.md` §5 item 10 notes `npx convex codegen` failed in sandbox (`ENOTFOUND o1192621.ingest.sentry.io`). The plan assumes it runs smoothly locally without mentioning network/unsandboxed execution or fallback steps.
3. **Verification script misunderstandings & omissions (Stage 5 `L254-256`):**
   - `npm run verify` (`package.json:31`) is `npm test && npm run test:perf && npm run build && npm run verify:loading-bundles` — it **already runs** `test:backend` (including `test:hubspot` and `test:exports`), so running those separately after `npm run verify` is redundant.
   - Conversely, `npm run verify` does **not** run **`npx tsc --noEmit -p src/convex/tsconfig.json`** (required to typecheck Convex functions against `src/convex/tsconfig.json`, per `docs/hubspot.md:117`) and does **not** run **Prettier** on Pass 2's 15 unformatted files or new edits.
4. **Zero automated test coverage on rewritten critical paths:** While respecting `AGENTS.md` (no new tests unless requested), the plan rewrites or adds complex logic in areas with **zero** existing backend tests — most notably `companyDeletion.ts` (`clean` is untested end-to-end), `approvals.ts`, `retractBuyerLinkConcession`, `discussionInvalidation.ts`, and `DiscussionSession` retries/pagination. The plan should at least prescribe a deterministic manual/scripted table-inventory cross-check for `companyDeletion.ts` against all tables in `src/convex/schema.ts`.
5. **Missed browser cache namespace (`dinu:workspace-read:v1`):** Stage 5 bumps `src/lib/contract/browser-storage.ts:14` (`dinu:v8` → `dinu:v9`), but misses `src/lib/auth/workspace-read-storage.ts:45` (`dinu:workspace-read:v1:...`, IDB version `3`), which caches `templateDetails` validated through `persisted-values.ts` (tightened in Pass 2 and Stage 4.5).
6. **Doc parity errors & omissions (Stage 5 `L249-252`):**
   - **False removal (`L251`):** Instructs removing `"dinu:drafts:v7"` from `docs/hubspot.md` as stale — **wrong**, `dinu:drafts:v7` is the **current live** draft namespace (`src/lib/contract/draft-recovery.svelte.ts:12`).
   - **Missed stale docs:**
     - `docs/retention.md:9` (still lists `contractCreationReceipts`)
     - `docs/deployment.md:141,147` (still references `authoringMigrations` / `authoringMigration:begin`)
     - `docs/template-authoring-storage.md:182,265` (still documents `authoringMigration`, and wrongly says `IndexedDB schema 2` while `workspace-read-storage.ts:332` uses `3`)
     - `docs/template-storage.md:94,98` (still references `authoringMigration.begin/step/finish`)
     - `docs/document-formatting.md:110` (still references `templateSourceFormatting`)
     - `docs/company-deletion.md` (will drift after Stage 4.3 rewrite)
     - `README.md:125,126,141` (still claims approval emails capture concession details, link to `?review=1`, and deletion removes snapshots — beyond just `L129-130`)

---

### D. Minor Line-Number & Reference Inaccuracies

- **Stage 1.3 (`L120`):** Cites `emailDeliveries.ts` `beginDispatch` at `L371-379`; `beginDispatch` is actually `L281-306` (`L371-379` is `recover`).
- **Stage 3 (`L174`):** Cites `crypto.randomUUID()` in `session.svelte.ts` at `L789, L829, L871`; actual lines are `L828, L853, L876, L908` (4 sites).
- **Stage 3 (`L178`):** Cites `savePending()` in `review-controller.svelte.ts` at `L122, L165, L199`; `L199` (`resolveCompletion`) does not currently call `savePending()` at all (though adding `if (!(await this.options.persistence.savePending())) return;` there is worth deciding explicitly so an admin doesn't send a completion email over unsaved local edits).

---

## Recommended Amendments Before Executing

1. **Stage 0:** Add `npx tsc --noEmit -p src/convex/tsconfig.json`, Prettier formatting for Pass 2 files, note how `npx convex codegen` will be run (unsandboxed / live credentials), and create a clean git checkpoint commit once Stage 0 passes.
2. **Stage 1.1:** Also remove the `stateRevision` bump in `src/convex/hubspotDeals.ts:208`; fix the equal-revision cache-clobbering race (order equal `stateRevision` by monotonic `savedAt` in `olderContractState`/cache writes); commit explicitly to monotonic `savedAt` (drop the broken `"OR"` clause); decide explicitly whether `hubspotQuotes.gated` checks `root.title !== row.title`; correct file paths to `wordExportGeneration.ts` and `hubspotQuoteActions.ts`.
3. **Stage 1.2 & 2.1:** Redesign `discussionInvalidation.ts` pagination so `continueCursor` **never** skips unprocessed mid-page threads; ensure `deleteAffectedComments` fetches any `prevView.concessions` IDs missing from `preloaded.itemsById`; cover both `buyerLinks` lookups in `accounts.ts:205-212`.
4. **Stage 1.3:** Decide `approvals.complete` return vs throw semantics and update `ContractReviewController.reconcile()` for `expectedDecidedAt`; handle `approvals.request` `'skipped'` by creating a fresh delivery with current `recipientEmail` (without duplicate HubSpot activity); scope orphan-delivery deletion to contract deliveries and run it before scheduling retries/cooldowns.
5. **Stage 2.2 & 2.3:** Specify how `continueDeleteAffected` gets block ordinals (and handles synthetic inserted block keys); replace the regex recommendation with memoized DP in `dom-anchor.ts`; verify strict `<` vs `<=` for zero-length boundary insertions; keep the Convex `appliedOverlay` wire validator minimal instead of adding dummy `audience`/`annotations` fields.
6. **Stage 3:** Split `persistence.svelte.ts` stale-replay handling into superseded-draft clear vs genuine-conflict detection; define `operationId` rotation on definite `ConvexError` and delete-confirmation ownership in discussions; specify `endCursor` + `SplitRequired` design for `PaginatedFeed`.
7. **Stage 4:** Add `src/convex/templateSourceParser.ts` (`analyzeExisting`), `src/convex/deletionValidators.ts`, `src/convex/templates.ts` (`saveChangedVersion`), and `scripts/{operator-types.ts,migrate-authoring.mjs,template-source-roles.mjs,company-convex.mjs}` to Stage 4.2; commit to keeping 24h TTL on `operationReceipts` in Stage 4.1; resolve the `tests/backend/contracts/saving.test.ts` 2-selection `snapshotBlocks: 0` conflict before enforcing `concession.changes.length > 0` in Stage 4.5.
8. **Stage 5:** Keep `"dinu:drafts:v7"` in `docs/hubspot.md`; expand the doc parity list to all affected docs (`retention.md`, `deployment.md`, `template-authoring-storage.md`, `template-storage.md`, `document-formatting.md`, `company-deletion.md`, `README.md`); consider bumping `dinu:workspace-read:v1`; include `npx tsc --noEmit -p src/convex/tsconfig.json` and Prettier in final verification.
