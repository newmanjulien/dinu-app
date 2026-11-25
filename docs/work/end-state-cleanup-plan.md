# End-State Cleanup & Hardening Plan

This plan finishes and hardens the two uncommitted refactors currently in the working tree:
1. [playbook-only-refactor-handoff.md](playbook-only-refactor-handoff.md) — Playbook-only contract model (removed materialized contract documents, buyer proposals, dual-lane reviews, native staging, tape-splice discussions, output proofs, 90-day retention, 6-step export/quote lifecycle).
2. [template-authoring-toolbar-simplification-handoff.md](template-authoring-toolbar-simplification-handoff.md) — Unified Rep/Buyer template authoring, `by_companyId_and_audience`, stricter authoring validators, unified editor/toolbar (Pass 2 currently unverified due to runner exit 137).

> **Execution ground rules (`AGENTS.md`):**
> - Start from the best, simplest, most robust end state and work backward. Backwards compatibility is **not** required (a clean DB reset is assumed).
> - Always read `src/convex/_generated/ai/guidelines.md` before modifying Convex functions.
> - Do **not** add new tests unless explicitly asked; maintain affected existing tests/fixtures and preserve all `npm run test:perf` guarantees without weakening assertions.
> - Do **not** use Playwright/browser automation; verify via `npm run verify`, `npm run seed:verify`, and targeted existing backend test suites.

---

## 1. Locked Decisions

These three policy/architecture decisions are final:

1. **Admin revoke (`approved → rejected`) on a live buyer link:**
   - Immediately pull back **only** the revoked concession from `buyerLinks.currentView`, while continuing to hold back newly drafted `pending` edits until the contract is ready.
   - **Implementation requirement:** Do **not** run full `syncBuyerLink` on `approved → rejected` when other concessions are pending (that would prematurely leak other held-back approved edits). Instead, add a targeted `retractBuyerLinkConcession(ctx, root, itemId)` that removes only `itemId` from `link.currentView.concessions` (if present), bumps `contentRevision`, recomputes `displayIdentity`, and runs `deleteAffectedComments` for that single removal. When `contractReadiness(nextConcessions).ready` is `true`, full `syncBuyerLink` runs as usual.
2. **`savedContracts.stateRevision` semantics:**
   - `stateRevision` tracks **concessions and review state only**.
   - Remove `stateRevision` bumps from `hubspotRecipients.commit`, `contractPolicy.markDealUnavailable`, **and** `contracts.rename`.
   - Enforce title freshness explicitly where filenames/payloads depend on it (`expectedTitle` on `contractExports.commit` and `hubspotQuotes.commit`). Live title sync to buyer links continues through `syncBuyerLinkMetadata`, and live client updates continue seamlessly because `olderContractState` uses strict `<` (`next.stateRevision < current.stateRevision`).
3. **Delete legacy migration code (`authoringMigration.ts` + `templateSourceFormatting.ts`):**
   - Delete both `src/convex/authoringMigration.ts` and `src/convex/templateSourceFormatting.ts`, the `authoringMigrations` table, `company.authoringMigration`, and all migration gates across `templates.ts`, `playbookItems.ts`, `authoringValidation.ts`, and `companyDeletion.ts`.
   - **Keep** `src/convex/authoringValidation.ts` (`certify`, `writeValidationFacts`, `readValidationFacts`, `validationCertified`, `templateSourceCertificates`, `templateSourceValidationChunks`), and tighten `templateVersions.validation` from `v.optional(...)` to **required** (`format: 0 | VALIDATION_CODEC_VERSION`).

---

## 2. Target End-State Invariants

Every change in Stages 0–5 exists to make these six invariants hold cleanly across the whole stack:

1. **Honest contract revisioning:** `stateRevision` changes only on concession/review mutations (`contracts.save`, `approvals.decide`). Background HubSpot updates and renames never trigger false save conflicts or silently abort queued HubSpot Quote pushes. Directory writes never silently drop when two saves occur in the same millisecond.
2. **Single live/draining/deleted choke point:** Every `buyerLinks` read checks `currentView !== null` via one shared helper. Link revocation on delete happens in one place (`ensureContractCleanup`). No mutation redundantly re-reads `memberships`, `contractCleanups`, `contractDirectory`, `templateSourceBlocks`, or `playbookItemRevisions` when the caller already loaded them.
3. **Unified Playbook-only geometry & overlays:** A contract is `(immutable templateSourceBlocks) + (selected rep concessions)`. One shared overlap/impact engine covers text ranges, removed blocks, empty/table/previously-removed intermediate blocks, and boundary insertions for **both** discussion invalidation and buyer-explanation filtering. One backend helper (`readAppliedOverlays`) projects applied overlays in the exact `DocumentOverlay` shape for buyer links, Word exports, and HubSpot Quotes.
4. **Hard Convex transaction-budget compliance everywhere:** Zero unbounded deletion loops anywhere in `src/convex/`—including `discussionInvalidation.ts`, which must run under `cleanupBudget(ctx)` from `src/convex/cleanup.ts`.
5. **Uniform idempotency & complete state machines:** One receipt table (`operationReceipts`) handles all idempotent commands including contract creation (`contractCreationReceipts` deleted). Every backend mutation writing receipts gets stable `operationId` retry reuse from its client (including `DiscussionSession`). Client controllers never move revisions backwards, reuse aborted cache promises, leak unaborted read attempts, or return ambiguous success on guarded no-ops. Async workers (`emailDeliveries`, `approvals`) always record valid terminal transitions.
6. **Zero legacy drag & strict parity:** No legacy migration modules, no rolling-deploy deletion fallbacks, no loose optional validator fields kept for old callers, no blank-concession test loopholes, and 1:1 parity across code, `src/convex/_generated/api.d.ts`, `data/convex/playbookItems.jsonl`, browser cache key (`dinu:v9`), and docs.

---

## 3. Intentional Complexity — Do NOT Break or Remove

These patterns look complex at first glance but protect real Convex limits, concurrency invariants, or UX guarantees. Preserve all of them:

- **`authoringValidation.ts` + compact binary `structure` codec + `templateSourceCertificates` + `templateSourceValidationChunks` + `templateVersions` byte counters:** Keeps ordinary Playbook authoring saves within Convex's 16 MiB / 4,096 read limits and `authoring-snappiness` perf budgets; async `certify` keeps bulk source import within single-transaction write budgets.
- **`itemHeadFields.currentRevisionId` optional on `playbookItems` table, required on `detailFields`:** Required for the atomic 2-step insert in `createAuthoringItem` (`Id<'playbookItems'>` must exist before inserting the initial `playbookItemRevisions` row).
- **`savedContracts.lastOperation` alongside `operationReceipts`:** Enables passive lost-response reconciliation through the existing live `contracts.state` subscription without polling.
- **`hubspotQuotes.commit` 2-pass `payload-required` flow + `discardFile` in `finally` + `storageOwnership.ts` `fileOwned`:** Prevents duplicate `_storage` uploads on deduplicated canonical pushes and prevents leaked blobs across all 5 owner tables.
- **`wordExports` separate 1h `downloadExpiresAt` vs physical `expiresAt` (`+15m` / `+30d+15m`):** Keeps `prepare` query clock-free/cacheable while respecting download grace and HubSpot's 30-day attachment hold.
- **`buyerLinks.capture` returning an existing link before checking readiness/revision:** Intentionally allows copying an already-created permanent link while pending edits exist.
- **`emailNotifications.ts` passing `companyName: event.title`:** `emails/approval.lmx` and `emails/decision.lmx` render `"the contract that's being prepared for {data.companyName}"`—so `companyName` in Loops is the buyer/contract title.
- **Two `$derived` `createDraftValidator()` closures in `AuthoringContext` & narrow args in `evaluateConcessionAddition`:** Prevents single-slot cache thrashing in `geometry-index.ts` and avoids re-validating geometry on every keystroke.
- **`SelectionSurface` keeping break indexing when `allowBoundarySelection === false`:** Required for multi-paragraph text drags on `/template/buyers`.
- **`src/routes/api/buyer/[token]/download/+server.ts` creating a fresh second `ConvexHttpClient` for `authorizeDownload`:** Avoids a pinned read timestamp from the first query.
- **`contractCleanup.ts` scheduling `hubspotQuotes` instead of falling through from `exports`:** Required by Convex's single-`.paginate()`-per-mutation rule.
- **`BuyerDiscussions` Clerk `__session` 401 guard + `coordinateDiscussionViewer`:** Prevents signed-in teammates with expired JWTs from silently posting anonymously as "Buyer" and prevents multi-tab cookie races.

---

## 4. Phased Execution Plan

Execute stages in order, verifying at each boundary so regressions never pile up.

---

### Stage 0 — Establish a Green, Verified Baseline

Pass 2 of the authoring/toolbar refactor was never compiled, formatted, or tested, and broke committed seed data. Stabilize before refactoring further.

1. **Regenerate committed seed data** so it satisfies Pass 2's non-blank instruction validation in `src/lib/playbook/validation.ts:138-144`:
   - `scripts/production-seed.mjs:502-511` already strips blank instruction keys, but `data/convex/playbookItems.jsonl` still has `"howToExplainToBuyers": ""`, `"commonObjections": ""`, `"negotiation": ""`.
   - Run `npm run seed:restore-export` and `npm run seed:reconcile` (or the repo's exact seed regeneration pipeline in `package.json`) so `data/convex/playbookItems.jsonl` matches.
2. **Regenerate Convex generated files:**
   - Run `npx convex codegen` to replace the hand-edited `src/convex/_generated/api.d.ts`.
3. **Verify Pass 2 baseline:**
   - Run `npm run verify` and `npm run seed:verify`.
   - Fix any compile, type, lint, or test errors surfaced in Pass 2's unverified files (`templates.ts`, `playbookItems.ts`, `operator.ts`, `validation.ts`, `authoring-context.svelte.ts`, `authoring-controller.svelte.ts`, `TemplateWorkspace.svelte`, `SourceSelectionToolbar.svelte`) before starting Stage 1.

---

### Stage 1 — Fix Core Contract State, `stateRevision`, Buyer-Link Retraction & Review/Email State Machines

#### 1.1 Clean `stateRevision` semantics & deterministic directory updates
- **`src/convex/hubspotRecipients.ts` (`L183-188`, `L204-209`):** Remove `stateRevision: contract.root.stateRevision + 1` from `commit` (both clear and update branches). Buyer company name updates must only update `buyer` and sync buyer link metadata.
- **`src/convex/contractPolicy.ts` (`L45`):** Remove `stateRevision: contract.root.stateRevision + 1` from `markDealUnavailable`. Deal availability is already enforced transactionally via `hubspot.availability` / `requireContractWork` / `contractWorkBlock`.
- **`src/convex/contracts.ts` (`L263-270`):** Remove `stateRevision: contract.root.stateRevision + 1` from `rename`. Keep `title`, `savedAt`, and conditional `buyer: { kind: 'manual' }`.
- **Explicit `expectedTitle` checks where filenames/payloads depend on title:**
  - `src/convex/contractExports.ts` (`commit`) and `src/convex/exportValidators.ts` + `src/convex/wordExport.ts`: pass `expectedTitle` captured at `prepare` and reject in `commit` if `contract.root.title !== args.expectedTitle`.
  - `src/convex/hubspotQuotes.ts` (`commit` and optionally `gated`) and `src/convex/hubspotQuoteValidators.ts` + `src/convex/hubspotQuoteActions.ts`: pass `expectedTitle` captured at `prepare` and verify `contract.root.title === args.expectedTitle` at `commit` (queued quotes already hold their rendered HTML/title; ensure `hubspotRecipients` buyer-name refreshes never cause `gated()` to abort a queued push).
- **`src/convex/contractState.ts` (`L151-157`) & `tests/backend/contracts/saving.test.ts` (`L231-260`):**
  - Fix the same-millisecond `directoryWrites` flake at the root: in `saveSelections` (`src/convex/contractSaving.ts`) and `approvals.decide` (`src/convex/approvals.ts`), or inside `patchContract` (`src/convex/contractState.ts`), ensure `savedAt` is monotonic (`Math.max(now, contract.root.savedAt + 1)`) OR trigger `writeDirectory` on `'stateRevision' in rootChanges` when `savedAt` is updated, while keeping `writeDirectory` idempotent when nothing in the directory projection changed. Verify `saving.test.ts` passes deterministically even when two saves run inside the same millisecond.

#### 1.2 Buyer-link retraction on Admin revoke & single live-link choke point
- **`src/convex/buyerLinks.ts` (`L76-142`):**
  - Factor out shared `patchBuyerLinkMetadata` helper so `syncBuyerLink` (`L86-97`) and `syncBuyerLinkMetadata` (`L125-141`) stop duplicating title/buyerName/`displayIdentity` patching.
  - Add `retractBuyerLinkConcession(ctx, root, itemId, preloaded?)`:
    - Look up `link = await liveLinkFor(ctx, root._id)`.
    - If `!link` or `!(itemId in link.currentView.concessions)`, return early.
    - Build `nextConcessions` by omitting `itemId` from `link.currentView.concessions`.
    - Patch `buyerLinks.currentView` with `nextConcessions`, `contentRevision: prevView.contentRevision + 1`, refreshed `title`/`buyerName`/`displayIdentity`.
    - Call `deleteAffectedComments(ctx, root, prevView.concessions, nextConcessions, prevView.contentRevision, preloaded)`.
  - Add shared `liveLinkFor(ctx, contractId)` (returns link only if `link?.currentView !== null`) and `hasActiveLinkForCreator(ctx, companyId, creatorId)` (scans/filters `currentView !== null`, bounding cleanly).
- **`src/convex/approvals.ts` (`L143-145`):**
  - If `contractReadiness(nextConcessions).ready` is `true`, call `syncBuyerLink(ctx, updated.root, preloaded)`.
  - Else if `current.status === 'approved' && nextStatus === 'rejected'`, call `retractBuyerLinkConcession(ctx, updated.root, args.itemId, preloaded)`.
- **`src/convex/accounts.ts` (`L205-212`):**
  - Update `readSetupProgress` to check `currentView !== null` (using the shared live-link helper from `buyerLinks.ts`) so a revoked buyer link on a draining deleted contract never falsely completes the `'buyer-link'` setup step.
- **`src/convex/contracts.ts` (`L281-288`):**
  - Remove the duplicate `buyerLinks` query and `currentView: null` patch from `contracts.remove`—`ensureContractCleanup` (`src/convex/contractCleanup.ts:54-56`) already executes it in the exact same transaction.

#### 1.3 Fix approval & email delivery state-machine bugs
- **`src/convex/approvals.ts` (`complete`, `L308-395`):**
  - Add `expectedDecidedAt: v.number()` (or `expectedStateRevision: v.number()`) to `approvals.complete` args and receipt `inputs`, and reject with a clear `ConvexError` if `completion.decidedAt !== args.expectedDecidedAt` (or `contract.root.stateRevision !== args.expectedStateRevision`). Update the client caller (`src/lib/contract/review-controller.svelte.ts`) to pass it.
- **`src/convex/approvals.ts` (`request`, `L185-258`):**
  - When an existing same-generation `emailDeliveries` row exists and reached `state.kind === 'skipped'`, handle it explicitly (restart/re-evaluate delivery without falling through to L258 and emitting a duplicate HubSpot `'requested'` timeline activity).
- **`src/convex/emailDeliveries.ts` (`beginDispatch`, `L371-379`):**
  - When `eligibleTarget` fails or `!to` (no recipients), transition the row to `skipped` and cancel `recoveryJobId` (matching `claim` at `L281-306`) before returning `null`, so `recover` never misclassifies an unsent email as `uncertain`.
- **`src/convex/emailDeliveries.ts` (`complete` / `recover`):**
  - When a delivery transitions to a settled state (`sent`, `failed`, `skipped`, or recovered terminal) and is no longer referenced by `savedContracts.review.request?.deliveryId` or `savedContracts.review.completion?.deliveryId` (detached by `removeDelivery` while `providerDispatchInProgress`), delete the orphaned row cleanly.

---

### Stage 2 — Budget-Bound Discussion Invalidation, Unify Document Geometry & Deduplicate Overlays

#### 2.1 Eliminate the 16 MiB transaction-limit crash bomb in `src/convex/discussionInvalidation.ts`
- Remove hardcoded `SYNC_THREAD_LIMIT = 64` / `MESSAGE_BATCH = 64` loops that can read up to `64 × 64 = 4,096` messages (~80 MB) inside `contracts.save` / `approvals.decide`.
- Drive both `deleteAffectedComments` and `continueDeleteAffected` with `cleanupBudget(ctx)` from `src/convex/cleanup.ts`:
  - Accept optional pre-loaded `{ blocks, itemsById, index }` from `saveSelections` (`src/convex/contractSaving.ts`) and `approvals.decide` (`src/convex/approvals.ts`) so `templateSourceBlocks` and `playbookItemRevisions` are never scanned twice in the same transaction.
  - Paginate `discussionThreads` with `.paginate({ cursor: null, numItems: ... })` inside `deleteAffectedComments` (or take a small bounded slice + pass `continueCursor` cleanly) and check `budget.exhausted()` **before** every thread and every message batch delete.
  - Delete the thread doc directly using the already-loaded `thread._id` (remove the redundant `ctx.db.get('discussionThreads', threadId)` in `deleteThreadAndMessages` when called with a loaded doc).
  - For any thread whose messages exceed the remaining budget, delete the thread row synchronously (so it vanishes immediately from live queries & unread state) and schedule `drainThreadMessages`, which also uses `cleanupBudget(ctx)`.
  - When `deleteAffectedComments` stops due to budget or remaining pages, schedule `continueDeleteAffected` with the **actual `continueCursor`** (never restarting at `cursor: null`).
  - Inside `continueDeleteAffected`, enforce `cleanupBudget(ctx)` per thread and per message batch so it can never hit Convex's 16 MiB limit or wedge in a retry loop.
- **Fix redundant `contractDirectory` read in `refreshDirectoryUnread` (`L37-41`):**
  - Remove the extra `contractDirectory.by_contractId` lookup before calling `writeDirectoryUnread` (or update `writeDirectoryUnread` to accept an optional `allowMissing` flag / preloaded row so it queries once).

#### 2.2 Unify overlap & anchor geometry across comments and buyer explanations
- Create one shared pure geometry-impact module (e.g., in `src/lib/playbook/overlay-impact.ts` or extending `src/lib/document/source-index.ts`) that computes the exact impact of a set of active or changed rep concessions against `SourceIndex`:
  - Text ranges (`[start, end)` in source coordinates)
  - Removed block keys
  - Boundary insertion keys (`afterBlockKey`)
  - Ordered block-index span coverage (so a span from block `B1` to `B3` knows every intermediate block `B2`—even if `B2` is empty, a table, or was previously removed by another concession).
- Wire **both** consumers to this shared helper:
  1. **`src/lib/discussions/anchors.ts` (`footprintAffectedByChanges`, `L295-319`):**
     - Fix the empty/table/previously-removed intermediate block gap (check block-order range between first and last block key of the footprint, not just `footprint.blockKeys.includes(afterBlockKey)`).
     - Fix zero-length insertions (`start === end`) sitting on anchor boundaries, and concession-only spans (`templateStart === undefined`) when an intermediate block is restored or inserted into.
  2. **`src/lib/playbook/document-overlay.ts` (`filterOverlappedExplanations`, `L100-143`):**
     - Check boundary insertions in addition to `structural.removed` and `textRanges`, so a multi-paragraph buyer explanation spanning an active rep concession's boundary insertion is properly suppressed.
- **`src/lib/discussions/dom-anchor.ts` (`matchesQuoteWithReferences`, `L157-202`):**
  - Replace the greedy `savedQuote.indexOf(segment, cursor + 1)` loop with an anchored literal-segment matcher (e.g., escaped regex with `.+` for each reference placeholder, or recursive backtracking with memoization) so repeated short literal separators like `", "` inside reference labels never cause false mismatches or false positives.

#### 2.3 Deduplicate `appliedOverlays` projection
- Add a single `readAppliedOverlays(ctx, reader, concessions)` helper in `src/convex/templates.ts` (and delete dead `versionReader.selectedItems` at `L582-606`).
- Return overlays in the canonical `DocumentOverlay` shape (or one shared validator) and use it in:
  - `src/convex/buyerLinks.ts` (`L487-499`)
  - `src/convex/contractExports.ts` (`L92-104`)
  - `src/convex/hubspotQuotes.ts` (`L195-207`)
- Remove the 4× downstream `{ ...overlay, audience: 'rep', annotations: [] }` re-wrapping in `src/convex/wordExportGeneration.ts:23-27`, `src/convex/hubspotQuoteActions.ts:20-24`, `src/lib/buyer/BuyerDocument.svelte:56-60`, and `src/routes/api/buyer/[token]/download/+server.ts:39-43`.

---

### Stage 3 — Fix Client State Machines & Wire Idempotent Discussion Retries

1. **`src/lib/contract/persistence.svelte.ts` (`L305-312`):**
   - On lost-response receipt replay, when `olderContractState(result.state, this.confirmed)` is true (server has already moved past the replayed save), do **not** call `this.acknowledgeRequest(result.state)` with the older revision. Clear/resolve the in-flight request while preserving `this.baseStateRevision >= this.confirmed.stateRevision` so `baseStateRevision` never regresses backwards.
2. **`src/lib/buyer/contract.svelte.ts` (`L128-152`, `L334-339`, `L407-425`):**
   - Call `this.templateReads.clear()` synchronously inside `release()` before/when aborting `this.lifetime`, eliminating the microtask race where `retry()` → `start()` attaches to an already-aborted promise.
   - Pass `this.lifetime` as `initialLifetime` in `retryDocument()` (`subscribeState(this.generation, this.lifetime)`) so retries are properly aborted on `release()`/`destroy()`.
3. **`src/lib/discussions/session.svelte.ts`:**
   - **Real retry idempotency:** Store a stable `operationId` on `activeComposer` (and on pending edit/delete state) instead of minting `crypto.randomUUID()` on every click (`L789`, `L829`, `L871`). Reuse the same `operationId` across retry attempts of the same submission; regenerate only after completion or when the draft text/target changes. This makes retries replay cleanly against `discussionCommands.ts`'s `operationReceipts` instead of duplicating comments.
   - **Guarded `deleteMessage` return (`L898`):** Return an explicit result (e.g., `boolean` / `{ status: 'ignored' | 'deleted' | 'error' }`) instead of `undefined` when blocked by `readOnly || deletingMessageId || activeComposer?.busy`.
   - **Composer vs thread-switch race:** Capture the composer instance/generation before awaiting `submit()` and do not steal `selectedThread` back if the user navigated to another thread while busy (or explicitly cancel/clear `activeComposer` on thread switch when not busy and guard post-await selection when busy).
   - **`PaginatedFeed` pagination resilience:** Handle Convex `splitCursor` / `isDone` transitions without unnecessarily dropping and re-subscribing all tail pages on cursor shift.
4. **`src/lib/contract/review-controller.svelte.ts` (`L122`, `L165`, `L199`):**
   - Explicitly check `if (!(await this.persistence.savePending())) return;` instead of discarding the return value.
5. **Authoring & UI cleanup:**
   - `src/lib/playbook/authoring-controller.svelte.ts` (`L448-456`): stop coercing whitespace-only input to `{ kind: 'none' }` on every keystroke in `setApprovalGuidance`; preserve typed text while editing and normalize on save/blur (consistent with `setInstruction`/`setExplanation`).
   - Remove dead `.replace(/downloading/gu, 'pushing to HubSpot')` in `src/lib/components/workspace/RepWorkspace.svelte:664-665`.
   - Remove dead optional fallbacks in `src/lib/components/playbook/RepPlaybookPanel.svelte:31,66` (`approvalPolicy.instructions ?? ''`, `concession.tier ?? 'preferred'`).
   - Remove dead `record.renderKey ?? old?.renderKey` fallback in `src/lib/playbook/template-authoring-session.svelte.ts:436`.

---

### Stage 4 — Zero-Backwards-Compat Structural Simplification

#### 4.1 Collapse `contractCreationReceipts` into `operationReceipts`
- Update `src/convex/contracts.ts` (`create`, `L180-224`) to store contract-creation receipts in `operationReceipts` using `result = contract.root._id` (raw ID string, identical to `src/convex/hubspotDeals.ts:110-128,222`), replaying `{ status: 'created', ... }` if the contract exists or `{ status: 'deleted' }` if deleted.
- Delete `contractCreationReceipts` from `src/convex/schema.ts`, remove its prune loop from `src/convex/operationReceipts.ts`, and remove the `contractReceipts` phase from `src/convex/companyDeletion.ts`.
- Also align `operationReceipts` vs single-contract deletion: either document clearly which namespaces rely on post-delete replay (`hubspotDeals`, `hubspotQuotes`, `contracts.create`) or add `by_contractId` cleanup for contract-local mutation receipts (`save`, `decide`, `approval-request`, `buyer-link-capture`, `discussions`) once `savedContracts` is gone.

#### 4.2 Delete legacy authoring migration scaffolding
- Delete `src/convex/authoringMigration.ts` and `src/convex/templateSourceFormatting.ts`.
- Remove `authoringMigrations` table and `company.authoringMigration` field from `src/convex/schema.ts`.
- Remove all `company.authoringMigration` guards/references from:
  - `src/convex/templates.ts`
  - `src/convex/playbookItems.ts`
  - `src/convex/authoringValidation.ts`
  - `src/convex/companyDeletion.ts`
- Tighten `templateVersions.validation` in `src/convex/schema.ts` from `v.optional(...)` to **required** (`v.object({ format: v.union(v.literal(0), v.literal(VALIDATION_CODEC_VERSION)), fingerprint: v.string() })` or `format: v.number(), fingerprint: v.string()`). Update any test fixtures that construct raw `templateVersions` without `validation`.

#### 4.3 Rewrite `src/convex/companyDeletion.ts` cleanly (~618 LOC → ~200 LOC)
- Delete the entire pre-nuke rolling-deploy fallback block in `case 'company'` (`L496-597`), which eliminates:
  - 4× duplicate `cleanupCompanyExports` calls
  - 3× duplicate `contractCleanups` drains
  - 2× duplicate `hubspotLinkBlocks` drains
  - the missing `cancelJob(ctx, row.recoveryJobId)` bug on `csmBookingAttempts` (`L563-566`).
- Replace the verbose phase switch with a clean, declarative ordered phase list while preserving the exact real barriers:
  1. Retire HubSpot / OAuth credentials & cancel scheduled Workpool/cron work; wait for started HubSpot/email actions.
  2. Drain all company-scoped child tables once each under `cleanupBudget(ctx)` (canceling all scheduled jobs, resetting quotas, deleting unowned `_storage` files via `deleteUnownedFile`).
  3. Delete `company` (and unowned `company.avatarId`) last, retaining only the permanent `companyDeletions` tombstone (`status: 'complete'`).

#### 4.4 Eliminate redundant per-mutation DB queries across backend helpers
- **`src/convex/discussionContext.ts` (`L20-27`) & `src/convex/discussions.ts` (`L28-40`, `L115-139`):**
  - Pass verified `access` into `discussionContext` / `discussionActor` instead of calling `requireMembership` and `memberForCompany` 2–3× per query/mutation.
  - Check `contractCleanups.by_contractId` once (inside `resolveView`/`resolveAccess`), not twice.
  - Drop `readContract` (and its `contractHubspotAssociations` lookup) from `discussionContext`—discussions only need `savedContracts` (`root`), never `hubspot`.
- **`src/convex/hubspotQuotes.ts` (`L160-174`, `L239-260`):**
  - Remove the redundant `requireMembership` call immediately preceding `seller(ctx, args)` in both `prepare` and `commit`.
- **`src/convex/hubspotDeals.ts` (`L212-221`, `L334`):**
  - Call `requestBuyerRefresh` once per deal-linked contract creation, not in both `createContract` and `hubspotDeals.commit`.
- **`src/convex/playbookItems.ts` (`L270-335`) & `src/convex/templates.ts` (`L213-223`):**
  - When creating a new item while `mutableVersionId` already exists, insert the initial `playbookItemRevisions` row with `mutableVersionId` directly instead of inserting without it and immediately running `markDraftItemRevision` + `addTemplateReadBytes`.
  - Remove the unused `pointer` parameter from `templateGenerations` (`src/convex/templates.ts:213-223`).
  - Optional polish: tighten `headReadBytes` budgeting in `playbookItems.ts:134` to reflect per-audience reads (`by_companyId_and_audience`) or document clearly that it conservatively bounds combined heads.

#### 4.5 Tighten remaining loose validators & delete dead remnants
- Make `expectedStateRevision` **required** (`v.number()`) in:
  - `src/convex/exportValidators.ts:7`
  - `src/convex/hubspotQuoteValidators.ts:13`
  - `src/convex/buyerLinks.ts:317,454`
- Remove unused optional `workBlock: v.optional(workBlock)` from `contractState` in `src/convex/savedContractValidators.ts:25` (keeping required `workBlock` on `liveContractMetadata`).
- Fix the 3 synthetic test fixtures that use `changes: []` on concessions, then enforce non-blank `concession.description` and `concession.changes.length > 0` in `src/lib/playbook/validation.ts:132-137`.
- Align `src/lib/contract/persisted-values.ts:215-241` with `validateTemplateItemContent`: reject blank instruction strings (`!text.trim()`) and delete the duplicate `sourceTarget(value.trigger.target)` check at `L241`.
- Delete dead materialized-doc alias remnants: `baseAliases` in `src/lib/document/compose.ts:108` and `aliases` in `src/lib/document/source-index.ts:46`.

---

### Stage 5 — Sync Cache Namespace, Codegen, Docs & Final Verification

1. **Bump client browser cache namespace:**
   - Update `src/lib/contract/browser-storage.ts:14` from `dinu:v8` to `dinu:v9` so clients cleanly discard pre-refactor local cache entries.
2. **Regenerate Convex types:**
   - Run `npx convex codegen` so `src/convex/_generated/api.d.ts` and `dataModel.d.ts` reflect the final schema (no `contractCreationReceipts`, no `authoringMigrations`, no `authoringMigration`/`templateSourceFormatting` modules).
3. **Bring docs into 100% parity with the final code:**
   - `docs/data-model.md`: update exact table count, fix `discussionThreads.footprint` schema (`{ templateStart?, templateEnd?, blockKeys[], concessions[] }`), document clean `stateRevision` semantics, `dinu:v9`, and removal of `contractCreationReceipts` / `authoringMigrations`.
   - `docs/email-delivery.md`: remove stale L7 claim about delivery snapshots.
   - `docs/hubspot.md`: remove stale references to `"late acknowledgments"`, `"reserved download attempts"`, `"output evidence"`, `"document revisions"`, and `"dinu:drafts:v7"`.
   - `README.md` (`L129-130`): remove stale `"emailSelectionChunks"` claim.
4. **Run full automated verification:**
   - `npm run verify` (runs `npm run test:perf`, `tsc`, `svelte-check`, and production build)
   - `npm run seed:verify`
   - Targeted existing backend test suites covering touched subsystems (`npm run test:hubspot`, `npm run test:exports`, plus existing contract/approval/discussion/cleanup/authoring backend tests).
5. **Report clearly:**
   - List every automated check run and passed, and explicitly call out anything that remains unverified by automation (e.g., live HubSpot OAuth/Quote/Company API behavior, live Loops delivery, real browser interactions, and clean DB reset/re-seed on dev deployment).
