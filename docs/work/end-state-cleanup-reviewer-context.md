# Context & Rebuttal Brief for the Plan Reviewer

**Purpose:** Give the reviewing agent (which produced [end-state-cleanup-plan-review.md](end-state-cleanup-plan-review.md)) all missing architectural context, verified source-code corrections to its own proposed fixes, and the locked user decisions—without altering [end-state-cleanup-plan.md](end-state-cleanup-plan.md).

---

## 1. Honest Scorecard: Where the Review Was Right

Contrary to any assumption that the reviewer only skimmed the plan, the reviewer **did inspect the actual codebase** and caught real bugs, missed call sites, and broken mechanics in `end-state-cleanup-plan.md`. The following catches are **verified and should be adopted**:

1. **Weakness #1 (`discussionInvalidation.ts` mid-page `continueCursor` bug):** Valid and critical. Breaking mid-page inside a Convex `.paginate()` loop and forwarding `page.continueCursor` permanently skips the remaining threads on that page. *(See §2.4 below for a cleaner fix than either the original plan or the review's Fix #1.)*
2. **Weakness #2 (Missed callers for deleting `authoringMigration.ts` + `templateSourceFormatting.ts`):** All four verified:
   - `src/convex/templateSourceParser.ts:13-59` (`analyzeExisting` calls `internal.templateSourceFormatting.inspectSource`; keep `prepare` at `L61-101` which is live via `templateUploads.ts:415`).
   - `scripts/operator-types.ts:7-15`, `scripts/migrate-authoring.mjs`, `scripts/template-source-roles.mjs`, `scripts/company-convex.mjs:97-113` (required for `npm run check:tools` inside `npm run verify`).
   - `src/convex/deletionValidators.ts:38,42` (`'authoringMigrations'`, `'contractReceipts'` in `companyCleanupPhases`).
   - `src/convex/templates.ts:446-467` (`saveChangedVersion` / `TemplateVersionContent` / `writeTemplateVersion` must supply `validation` unconditionally once `templateVersions.validation` is required; plus raw test fixtures like `tests/backend/contracts/saving.test.ts:65-79` also omit `validation`).
3. **Weakness #3 (`ContractPersistence` lost-response replay in `src/lib/contract/persistence.svelte.ts:305-312`):** Valid and critical. Simply clamping `baseStateRevision = confirmed.stateRevision` while keeping `draftSelections` non-null and `resolution = { kind: 'current' }` lets `finally { this.start() }` (`L338`) silently overwrite Teammate B's rev 9. Splitting into the two exact cases (draft equals replayed rev 8 → clear draft & advance to rev 9; user added local edits beyond rev 8 → keep draft & mark `resolution = { kind: 'conflict' }`) is the right fix.
4. **Weakness #4 (`tests/backend/contracts/saving.test.ts:229-268` collision with `concession.changes.length > 0`):** Valid and critical catch. *(See §2.3 below for the deeper context and cleaner architectural fix via `readValidationFacts`.)*
5. **Weakness #5 (Broken `"OR"` option for same-ms `savedAt`):** Valid. `contractDirectory` does not store `stateRevision`, and `writeDirectory` skips replacement when all projected columns match, so monotonic `savedAt = Math.max(now, contract.root.savedAt + 1)` is the only working fix.
6. **Weakness #6 (`dom-anchor.ts` regex ReDoS + `continueDeleteAffected` missing block ordinals + zero-length boundary verification):** Valid. Use memoized DP/backtracking instead of `.+` regex on 20 KB quotes; carry or derive block-order spans safely for `continueDeleteAffected` (handling synthetic concession-inserted `blockKey`s absent from `index.blockOrdinals`); verify strict `<` vs `<=` against `compose.ts` / `anchorPassage` before changing.
7. **Weakness #7 (Missed `src/convex/hubspotDeals.ts:208`, equal-revision cache clobbering, wrong file path `wordExport.ts` → `wordExportGeneration.ts`, explicit `hubspotQuotes.gated` title decision):** All valid catches. *(However, the reviewer's own proposed `savedAt` fix is broken—see §2.1 below!)*
8. **Weakness #8 (`preloaded.itemsById` missing earlier-removed `prevView.concessions` IDs, explicit unconditional-retract policy, both `accounts.ts:205-212` `buyerLinks` checks):** All valid.
9. **Weakness #9 (`approvals.complete` `skipped` vs throw & `reconcile()` clearing on `decidedAt`, `approvals.request` `'skipped'` stale `recipientEmail` trap, `emailDeliveries` ignoring `'invitation'` and detaching before scheduling retries/cooldowns):** All valid.
10. **Weakness #10 (Keep Convex `appliedOverlay` wire validator narrow):** Valid. Deduplicate the 3 backend projections into `readAppliedOverlays` without adding dummy `audience: 'rep'` / `annotations: []` over the wire; narrow downstream consumers or share one client/lib adapter.
11. **Weakness #11 (`DiscussionSession` `ConvexError` `operationId` rotation, `delete-confirmation.svelte.ts`, `PaginatedFeed` `[cursor, endCursor]` + `SplitRequired`):** All valid.
12. **Section C & D catches:**
    - `dinu:drafts:v7` (`src/lib/contract/draft-recovery.svelte.ts:12`) **is still live**—do NOT remove it from `docs/hubspot.md`.
    - `npm run verify` (`package.json:31`) already runs `test:hubspot`/`test:exports`, does **not** run `npx tsc --noEmit -p src/convex/tsconfig.json`, and does **not** run Prettier.
    - Checkpoint git commit after Stage 0, `npx convex codegen` network/unsandboxed note, the 7 additional stale docs (`retention.md`, `deployment.md`, `template-authoring-storage.md`, `template-storage.md`, `document-formatting.md`, `company-deletion.md`, `README.md`), and the 3 minor line-number corrections are all valid.

---

## 2. Where the Reviewer Missed Context or Proposed a Broken/Incomplete Fix

### 2.1 Equal-Revision Ordering (Weakness #7) — Reviewer's `savedAt` Fix Is Broken
The reviewer proposed:
> *"Ordering equal-revision updates requires comparing `savedAt` (monotonic) or a dedicated metadata clock when `stateRevision` ties."*

Using `savedAt` **will not work** for three verified reasons:
1. **`contractState` does not have `savedAt`.** In `src/convex/savedContractValidators.ts:19-36`, `savedAt` exists on `contractMetadata`, **not** on `contractState` (which is what `contracts.save`, `approvals.decide`, and `olderContractState(next: ContractState, current: ContractState)` operate on).
2. **`savedAt` owns contract directory sort order** (`by_companyId_and_savedAt_and_createdAt`). Per `docs/hubspot.md:17,25`, deal relinking (`hubspotDeals.ts:208`), deal unavailability (`contractPolicy.markDealUnavailable`), and background HubSpot buyer-name refreshes (`hubspotRecipients.commit`) **must NOT change `savedAt` or directory ordering**. Ordering equal `stateRevision` by `savedAt` therefore still lets stale responses clobber relinks, deal availability, and buyer names!
3. **The smoking gun is still in `src/lib/contract/saved.ts:67`:**
   ```ts
   /** Canonical metadata has one freshness version, independent of business revisions. */
   export function olderContractState(next: ContractState, current: ContractState) {
   ```
   Before Refactor 1, `savedContracts` had a dedicated `metadataRevision` separate from business revisions. Refactor 1 collapsed them into one `stateRevision`, which is the root cause of BOTH the false save/quote conflicts AND the equal-revision clobbering race.

**Correct end-state design:**
- Keep **`stateRevision`** strictly for business content & review state (`contracts.save`, `approvals.decide`)—used by `expectedStateRevision`, `ContractPersistence.baseStateRevision`, `wordExports`, `hubspotQuotes`, and `buyerLinks.capture`.
- Add a lightweight monotonic **`metadataRevision`** on `savedContracts` (and `contractState`), incremented automatically inside `patchContract` whenever *any* root field or HubSpot association changes (saves, decisions, renames, relinks, deal availability, buyer company name).
- Make `olderContractState(next, current)` compare `next.metadataRevision < current.metadataRevision`.
- Result: zero stale-cache clobbering for renames/relinks/availability/buyer-names, zero `savedAt` directory-order corruption, and zero false conflicts or aborted HubSpot Quote pushes.

*(Also note the one remaining explicit decision to confirm with the user for `hubspotQuotes.gated()`: whether renaming a contract while a quote push is `queued` should abort the push via `root.title !== row.title`, or let the queued push finish with the title captured at `prepare`/`commit`.)*

---

### 2.2 `operationReceipts` Post-Delete Replay Rationale (Weakness #12) — Reviewer Repeated a False Claim From Handoff 1
The reviewer wrote:
> *"`playbook-only-refactor-handoff.md:175` already established why `operationReceipts` has no `by_contractId` index: single-contract deletion must preserve in-flight replay fences (`save`, `quote`, `create`), and rows already self-expire in 24h."*

**This is factually wrong about `save`** (and `decide`, `request`, `complete`, `buyerLinks.capture`, `discussions`):
- Look at `src/convex/contracts.ts:238-244`: `contracts.save` calls `accessibleContractState(ctx, id, access)` and immediately returns `{ status: 'deleted' }` **before** `saveSelections` ever reads `operationReceipts`.
- Likewise, `approvals.{decide,request,complete}`, `buyerLinks.capture`, and `discussions.{write,markSeen}` all check contract/link existence first.
- **Only `contracts.create`, `hubspotDeals`, and `hubspotQuotes`** actually query `operationReceipts` before checking contract existence.

**Correct end-state conclusion:** Keeping 24h TTL retention on `operationReceipts` (with no `by_contractId` index and no `contractCleanup` drain) **is** still the simplest clean end state—just document the **accurate** reason (`contracts.create`, `hubspotDeals`, and `hubspotQuotes` replay before existence checks, and all receipts self-expire in 24h) rather than repeating Handoff 1's false claim about `save`.

---

### 2.3 `saving.test.ts` Collision With `concession.changes.length > 0` (Weakness #4) — Missing Perf & Architecture Context
The reviewer rightly caught that enforcing `concession.changes.length > 0` collides with `tests/backend/contracts/saving.test.ts:229-268`, which saves two items (`first`, `second`) from `tests/support/contract-data.ts` (`changes: []`) and asserts `snapshotBlocks: 0`.

**Context the reviewer didn't trace all the way through:**
1. In `tests/backend/contracts/saving.test.ts:50-55,65-79`, the `snapshotBlocks: 0` pass on 2 selections is currently an **accidental/synthetic pass**: both items come from `tests/support/contract-data.ts:25` (`changes: []`), so `contractSaving.ts:95` (`if (itemsWithChanges.length > 1)`) evaluates `0 > 1` (`false`) and skips conflict checking altogether. Every real Playbook concession in production (`data/convex/playbookItems.jsonl`) has `changes.length >= 1`—meaning in production, saving 2+ concessions currently **does** read full `templateSourceChunks` prose (`reader.blocks()`)!
2. Notice also `tests/backend/contracts/saving.test.ts:65-79` inserts a raw `templateVersions` document **without `validation`** and **without `templateSourceCertificates`**—so Stage 4.2 (making `templateVersions.validation` required) will touch this fixture regardless.
3. **The genuinely clean end-state fix (which satisfies BOTH real validation AND `snapshotBlocks: 0` in production and tests):**
   - Every certified template already persists its pre-built compact binary `SourceIndex` in `templateSourceCertificates` + `templateSourceValidationChunks` (`readValidationFacts` in `src/convex/authoringValidation.ts:124-167`), specifically so mutations don't have to read full template prose (`templateSourceChunks`).
   - In `src/convex/contractSaving.ts:95`, when `itemsWithChanges.length > 1`, check conflicts using `readValidationFacts` when certified (falling back to `reader.blocks()` only when uncertified `format === 0`, e.g., before async `certify` completes).
   - Update `tests/support/contract-data.ts` + `saving.test.ts` to use **two real, non-overlapping concessions** (`changes.length === 1` on distinct ranges of `text-1`) plus a certified `templateSourceCertificates` row (and required `validation` on `templateVersions`).
   - Result: `validation.ts` enforces real non-empty concessions, **production** 2-concession saves avoid reading up to 8 MB of template prose, and `saving.test.ts` proves `snapshotBlocks: 0` on *real* concessions instead of hollow `changes: []` fixtures!

---

### 2.4 `discussionInvalidation.ts` Budget & Pagination (Weakness #1) — Factual Cap + Cleaner End-State Design
- **Factual correction:** The reviewer stated templates can be *"~12–15 MiB of blocks"*. The actual hard limit in `src/convex/templateCapacity.ts:2` is **`MAX_SNAPSHOT_BYTES = 8_000_000` (8 MiB)**—still large enough that reading 8 MiB of blocks + items + unbounded messages can easily hit Convex's 16 MiB limit or trip `cleanupBudget`'s 4 MiB reserve (`src/convex/cleanup.ts:15`).
- **Trap in the reviewer's Fix #1:** If `budget.exhausted()` already trips *before* calling `.paginate()`, you must immediately schedule `continueDeleteAffected({ cursor: null })` rather than dropping invalidation. And scheduling a separate `drainThreadMessages` job per deleted thread creates unnecessary scheduler fan-out.
- **Cleanest end-state design for `discussionInvalidation.ts`:**
  - **Never delete messages inline inside the thread pagination loop** (`deleteAffectedComments` or `continueDeleteAffected`).
  - Before calling `.paginate({ cursor, numItems: 16, maximumBytesRead: ... })`, check `if (await budget.exhausted())`: if already exhausted, schedule `continueDeleteAffected` with the **current** `cursor` (starting at `null` from `deleteAffectedComments`) and return immediately—zero threads skipped.
  - Otherwise, process **100% of the fetched small page**: for each matching thread, synchronously delete `ctx.db.delete('discussionThreads', thread._id)` (so live queries and unread badges update atomically) and push `thread._id` into `deletedThreadIds`.
  - After finishing the entire page, if `deletedThreadIds.length > 0`, refresh directory unread once and schedule **one** cursorless worker `drainThreadMessages({ threadIds: deletedThreadIds })` that uses `cleanupBudget(ctx).drain(...)` to drain messages across the deleted thread IDs.
  - If `!page.isDone`, safely forward `page.continueCursor` to `continueDeleteAffected` because every single row on the current page was completely processed.

---

### 2.5 Minor Priority Nuance: `dinu:workspace-read:v1` (Section C #5)
- `src/lib/auth/workspace-read-storage.ts` already validates every cached `templateDetails` record on read through `validTemplate` (`src/lib/contract/persisted-values.ts`) and silently discards/evicts invalid records.
- Bumping `dinu:workspace-read:v1` → `v2` is **optional hygiene** (eagerly drops old IDB databases rather than lazily evicting stale records on read), not a crash bug.

---

### 2.6 Missing Session & Architectural Context
The reviewer didn't have the full conversation history behind `end-state-cleanup-plan.md`:

1. **Why the original plan missed grep-able secondary callers (`scripts/operator-types.ts`, `templateSourceParser.ts`, 7 secondary docs, 3 exact line numbers):**
   - The authoring session's shell runner failed on every command with **`exit 137` (`SIGKILL`)** (the same runner failure that left Conversation 2's Pass 2 uncompiled and untested). All research had to be done via targeted `read_file` calls without `rg`, `git grep`, `tsc`, or `vitest`.
2. **The 3 user-locked decisions (explicitly chosen by the user, not suggestions):**
   - **Decision 1:** Admin revoke (`approved → rejected`) immediately pulls back *only* the revoked concession on the live buyer link (`retractBuyerLinkConcession`), while continuing to hold back newly drafted `pending` edits until ready.
   - **Decision 2:** `stateRevision` tracks concessions & review state only (never bumped by `hubspotRecipients.commit`, `markDealUnavailable`, `hubspotDeals` relink, or `contracts.rename`), paired with `metadataRevision` for cache/subscription ordering (§2.1) and explicit `expectedTitle` checks on export/quote commits.
   - **Decision 3:** Delete both `authoringMigration.ts` and `templateSourceFormatting.ts` completely (along with `authoringMigrations`, `company.authoringMigration`, `templateSourceParser.analyzeExisting`, and legacy operator migration scripts), keeping `authoringValidation.ts` and making `templateVersions.validation` required.
3. **The 6 deeper architectural root causes that motivated the plan (so future edits solve root causes, not symptoms):**
   - Over-collapsed state/identity boundaries (`stateRevision` vs `metadataRevision`, and unexamined buyer-link auto-sync semantics on revoke).
   - Fuzzy live / draining / deleted boundaries (`buyerLinks.currentView !== null` enforced ad hoc instead of one choke point).
   - Uneven distributed-systems rigor (backend `operationReceipts` written for discussions while client minted fresh UUIDs; `emailDeliveries.beginDispatch` dropping out without terminal `skipped`; `ContractPersistence` losing monotonic invariants on replay).
   - Convex transaction-budget discipline enforced by memory instead of composition (`discussionInvalidation` bypassing `cleanupBudget`; defensive re-fetching of `memberships`/`contractDirectory`/`contractCleanups`/`blocks`/`items` inside child helpers).
   - Fragmented document-overlap geometry across 4 consumers (`anchors.ts`, `document-overlay.ts`, `dom-anchor.ts`, and 3× backend `appliedOverlays` projections).
   - Backwards-compatibility habits creeping into a zero-backwards-compat refactor (`authoringMigration`, `templateSourceFormatting`, `companyDeletion` rolling-deploy fallback, `contractCreationReceipts`, loose optional validators).
4. **Repo constraints from `AGENTS.md`:**
   - Do **not** create new tests or expand the test suite unless the user explicitly asks; maintain affected existing tests/fixtures only, and **never** weaken `npm run test:perf` assertions merely to pass.
   - Do **not** run Playwright or check things in a browser; the user verifies UI/browser behavior manually.
   - Report both verified automated guarantees and unverified external/manual areas honestly.
   - Zero backwards compatibility; optimize for the cleanest, simplest end state even if it requires churn.

---

## 3. Remaining Micro-Decisions Worth Confirming Before Execution

Everything from the combined plan + review is now fully reconciled except two small product-behavior calls that the reviewer rightly surfaced:

1. **`hubspotQuotes.gated()` on rename while a quote push is `queued`:** Should renaming a contract abort a queued HubSpot Quote push (`root.title !== row.title`), or allow the queued push to send with the title captured when the user clicked Push?
2. **`approvals.complete` stale-decision UX (`expectedDecidedAt` mismatch):** Keep returning `{ status: 'skipped' }` (silently dismissing the modal on stale decision, matching `docs/email-delivery.md:48` and current `ContractReviewController` behavior) OR throw `ConvexError` (showing an error banner so the admin explicitly re-reviews)? *(Note: either way, `ContractReviewController.reconcile()` at `src/lib/contract/review-controller.svelte.ts:95-102` must clear `completionAttempt` when `decidedAt` changes, not just `generation`, and `resolveCompletion` should flush/check `savePending()`.)*
