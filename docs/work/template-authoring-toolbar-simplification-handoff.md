# Engineering Handoff & Audit Report — Unified Template Authoring & Toolbar Simplification

---

## 1. Goal & Before/After Architecture

### Starting Problem
Merge and implement two overlapping prior plans — **Simplifying Rep Template Widget Code** (`989af26c-8a03-40f7-8d5a-43f93065a45e`) and **Simplify Buyer Template Buttons** (`ec870d34-0050-4f07-86a3-159f431f3ac9`) — from an end-state-first design with **zero backwards compatibility** (target Convex DB will be nuked and re-seeded after deploy). A second cleanup pass was then applied after self-audit uncovered bugs and missed simplifications; **Pass 2 has not yet been compiled, formatted, or tested** due to a terminal runner failure (`SIGKILL` / exit `137` on all shell commands).

### Before vs. After

| Area | Before | After |
|---|---|---|
| **Selection toolbar (`src/lib/components/document/SourceSelectionToolbar.svelte`)** | Async (`async/await`, `token` staleness guard, liveness callback). `/template` (Rep): 2 buttons (**Add instructions**, **Add concession**). `/template/buyers` (Buyer): 2 buttons (**Add explanation**, **Copy rep summary** querying `api.playbookItems.repSummary`). | 100% synchronous, controller-backed (`{ controller, container, snapshot, enabled }`). **1 button on both templates**: **Add instructions** (Rep) / **Add explanation** (Buyer). Step 2 (`autoConfirm`) fast-paths directly into `controller.confirmSelection(candidate)`. |
| **Authoring state machine (`AuthoringContext`, `AuthoringController`, `PlaybookEditor`)** | 4-state `Workflow` union (`creating-item` \| `creating-concession` \| `editing` \| `adding-concession`), separate `creationTitle` vs `editingTitle`, separate concession-creation top-level entry (`startConcessionFromSelection`, `beginNewConcessionAt`, `setConcessionTier`), concessions only addable/deletable on persisted items. | Single editor view + nullable `concessionDraft: ConcessionDraft \| null` sub-step. Always opens full instructions/explanation editor (`editingTitle` only; `creationTitle` deleted). Tier (`'preferred'` \| `'rare'`) is fixed by the entry button. Concessions can be added, previewed, and deleted on **unsaved** drafts before one atomic `saveTemplateItem`. |
| **Concession composer UI (`src/lib/components/playbook/ConcessionCreationEditor.svelte`)** | `Options` dropdown button opening `<Popover>` (`Popover.svelte`) containing `"This is a rare concession"` + `"This concession affects another part of the template"`. | `Popover.svelte` **deleted** (0 callers). Rare toggle removed. Single inline `<Checkbox label="This concession affects another part of the template" />`. |
| **Paragraph gaps (boundary targets)** | Rep: gap selection forced `Add concession` (instructions-only bookmark blocked). Buyer: selection layer painted boundary bar and rejected on mouseup. | Rep: gap selection opens full instructions editor; instructions-only (0 concessions, margin bookmark) OR concessions both allowed. Buyer: boundary selection disabled at selection layer (`allowBoundarySelection={false}` on `DocumentSelectionController` / `SelectionSurface`), snapping drags to text while preserving multi-paragraph text selection; `buyerExplanation.trigger` narrowed to `textTrigger`. |
| **Dismissal & focus (`BoxDismissal`, `TemplateWorkspace`, `PlaybookEditor`)** | `dismissFromOutside()` vs `cancel()`, `onDocumentBackground` dismissed during Step 2 location picking. Pass 1 added a reactive `previousFocusState` `$effect` (which caused focus theft on outside clicks). | Unified `cancel()`; `BoxDismissal` supports `dismissOnOutsidePointer={!locationPicking}` and `onDocumentBackground={locationPicking ? undefined : ...}`. Pass 2 deleted `previousFocusState` `$effect` and wired explicit focus transitions (`startConcession`, `cancelLocation`, `editor?.focusAddConcession(returnTier)` gated on `restoreFocus`). |
| **Convex schema & endpoints (`src/convex/`)** | `playbookItems` indexed only by `by_companyId`; `playbookItems.repSummary` public query; `audience` optional on `deleteTemplateItem`/`currentStructure`/`content`; `currentStructure`/`validateStructure` read and decoded both audiences' heads; `accounts.hasRepInstructions` scanned up to `MAX_PLAYBOOK_ITEMS + 1` heads and binary-decoded each; legacy optional fields on `templateVersions`, `currentTemplate`, `playbookItemRevisions`, `playbookItemCreationReceipts`, `detailFields`; `repInstruction.instructions` optional; `buyerExplanation.trigger` allowed boundaries; `currentTemplate` stored duplicated `authoringGeneration`/`structuralGeneration`. | `playbookItems` adds `.index('by_companyId_and_audience', ['companyId', 'audience'])` and top-level `audience: templateAudience`. `repSummary` **deleted**. `audience: templateAudience` required on `deleteTemplateItem`, `currentStructure`, `content`. `validateStructure` & `currentStructure` query `by_companyId_and_audience` + `orderedAudienceHeads`. `accounts.hasRepInstructions` is O(1) `.first()` on `by_companyId_and_audience`. `repInstruction.instructions` required (non-blank keys enforced in `validateTemplateItemContent`); `buyerExplanation.trigger` is `textTrigger`; `renderKey`, `headReadBytes`, `structureResultBytes`, `authoringGeneration`, `structuralGeneration`, `detailFields.currentRevisionId` required; `currentTemplate` stripped down to `{ companyId, versionId }` (no rewrite on mutable version updates). `committed()` split from `observation()` to skip certificate reads on mutation watermarks; `readValidationFacts` requires pre-fetched `certificate`. |
| **Workspace Convex decoupling (`TemplateWorkspace.svelte`)** | Direct imports of `useQuery`, `useConvexClient`, `api` for `repSummary`. | Zero Convex imports; all template I/O lives in `TemplateAuthoringSession` / `TemplateSource`. Explicit `audience: TemplateAudience` required across session/transport/controller/context/draft/picking/copy APIs (all `= 'rep'` defaults deleted). |
| **Cron / background jobs / client IndexedDB** | Unchanged. | Unchanged (`dinu:workspace-read:v1:...` schema 2 untouched; `crons.ts`, `companyDeletion.ts`, `accountDeletion.ts`, `contractCleanup.ts` untouched). |

### Earlier Assumptions / Refactors Superseded
- Supersedes the G19/G20 incremental migration compatibility layer (optional `headReadBytes`, `structureResultBytes`, `authoringGeneration`, `structuralGeneration`, `renderKey`, `detailFields.currentRevisionId`, fallback `pointer?.authoringGeneration`, fallback `readValidationCertificate` inside `readValidationFacts`).
- Supersedes `Copy rep summary` cross-audience read coupling on `/template/buyers` (`playbookItems.repSummary`).
- Supersedes the `creating-concession` / `creating-item` multi-mode authoring workflow and `SelectionActions` per-action eligibility matrix.

---

## 2. Complete File & Symbol Inventory

**Git commits made in this conversation:** **None** (0 commits). All edits are unstaged in the working tree on top of pre-existing unstaged repository changes.

### Deleted Files (1)
- `src/lib/components/ui/Popover.svelte` — removed after `ConcessionCreationEditor.svelte` dropped the `Options` dropdown (0 remaining callers).

### Created Files
- `docs/work/template-authoring-toolbar-simplification-handoff.md` (this handoff report). No runtime/source files were created.

### Modified Files (53 total)

#### `src/convex/` (11 files)
- `src/convex/schema.ts`: Added `.index('by_companyId_and_audience', ['companyId', 'audience'])` on `playbookItems`; made `playbookItemRevisions.renderKey`, `playbookItemCreationReceipts.renderKey`, `templateVersions.headReadBytes`, `templateVersions.structureResultBytes`, `templateVersions.authoringGeneration`, `templateVersions.structuralGeneration` required; removed `authoringGeneration` and `structuralGeneration` from `currentTemplate` (Pass 2).
- `src/convex/playbookValidators.ts`: Added `audience: templateAudience` to `storedTemplateItem`; made `detailFields.currentRevisionId` required `v.id('playbookItemRevisions')` (kept `itemHeadFields.currentRevisionId` optional).
- `src/convex/buyerValidators.ts`: Switched `buyerExplanation.trigger` from `trigger` to `textTrigger`.
- `src/convex/playbookItemRevisions.ts`: Added `export type UnrevisedDetailRecord = HistoricalItem & Pick<TemplateDetailRecord, 'renderKey'> & Partial<Pick<TemplateDetailRecord, 'lastOperation'>>`; simplified `itemRevision`, `storeItemRevision`, `replaceDraftItemRevision` signatures to `UnrevisedDetailRecord`; emitted `instructions` unconditionally in `businessItem`; required `renderKey` and dropped `?? revision.itemId` in `liveRevision`; wrote `audience` in `compactHead` and `createAuthoringItem`; asserted `structure.audience === head.audience` in `headStructure` and `revision.body.audience === head.audience` in `hydrateHead`.
- `src/convex/authoringValidation.ts`: Dropped `!` assertions on `headReadBytes`/`structureResultBytes` in `validationCertified`; changed `readValidationFacts(ctx, templateSource, certificate)` to require `Doc<'templateSourceCertificates'>` and deleted its fallback DB lookup.
- `src/convex/templates.ts`: Narrowed `TemplateVersionContent` to omit `'authoringGeneration' | 'structuralGeneration'`; simplified `templateGenerations` to read `version.authoringGeneration`/`version.structuralGeneration` directly; dropped `?? 0` and `!` on required fields across `snapshotCapacity`, `saveTemplateVersion`, `authoringReadCapacity`, `readAuthoringVersion`, `saveChangedVersion`; skipped `currentTemplate` rewrite on mutable in-place updates in `writeTemplateVersion` and removed generation fields from `nextPointer` (Pass 2); added `head.audience === reference.audience` check in `orderedHeads`; added `orderedAudienceHeads(version, audience, heads)`.
- `src/convex/templateSourceFormatting.ts`: Removed `ctx.db.patch('currentTemplate', ...)` generation patch in `storeRoles` (Pass 2).
- `src/convex/authoringMigration.ts`: Dropped `?? 0` on `headReadBytes`/`structureResultBytes` in `step`; added `head.audience !== reference.audience || revision.body.audience !== reference.audience` check in `step` and removed `currentTemplate` generation patch in `finish` (Pass 2).
- `src/convex/operator.ts`: Dropped `!item.currentRevisionId` check in `activeSeed`; updated `bootstrap` pre-allocation sizing to measure `initialHead` + `packedHead` (`encodeStructure(playbookStructure(item))`) and required `version`/`revision` fields (Pass 2).
- `src/convex/playbookItems.ts`: Deleted `repSummary`, unused `containsRange`, and redundant `validateStructuralReplacementContent`; split `committed()` (no certificate read) from `observation()`; required `audience: templateAudience` on `deleteTemplateItem`, `currentStructure`, `content`; switched `validateStructure` & `currentStructure` to `by_companyId_and_audience` + `orderedAudienceHeads`; hoisted `head.audience !== item.audience` above `playbookItemRevisions` read in `saveTemplateItem` (Pass 2); used `head.audience` directly in `deleteTemplateItem`, `content`, and creation-receipt replay; typed `proposed: UnrevisedDetailRecord`; dropped `?? 0` and `!` on required fields.
- `src/convex/accounts.ts`: Rewrote `hasRepInstructions` to `.withIndex('by_companyId_and_audience', ...).first()`; removed unused `ConvexError`, `MAX_PLAYBOOK_ITEMS`, `headStructure` imports.

#### `src/lib/` (28 files)
- `src/lib/document/source-validators.ts`: Split and exported `textSourceTarget` and `boundarySourceTarget`; composed `sourceTarget`.
- `src/lib/document/selection/selection-surface.ts`: Added `readonly allowBoundarySelection = true` to `SelectionSurface`; returned `null` in `resolve()` when `pureBreak && !this.allowBoundarySelection`.
- `src/lib/document/selection/document-selection.ts`: Added `readonly allowBoundarySelection = true` to `DocumentSelectionController`, passed to `SelectionSurface`, skipped `this.surface.breakAt(page, y)` in `#hit()` when `false`.
- `src/lib/document/runtime/resources.svelte.ts`: Added `allowBoundarySelection?: boolean` to `ViewerBindings`.
- `src/lib/components/document/RetainedViewer.svelte`: Forwarded `allowBoundarySelection={bindings?.allowBoundarySelection}` to `<DocumentViewer>`.
- `src/lib/components/document/DocumentViewer.svelte`: Accepted `allowBoundarySelection = true`, tracked in selection `$effect`, passed to `new DocumentSelectionController(...)`; removed `?.` on `item?.instructions.summary`.
- `src/lib/components/document/SourceSelectionToolbar.svelte`: Rewrote as synchronous single-action controller-backed toolbar (`{ controller, container, snapshot, enabled }`); deleted `LightningIcon`, `CopySimpleIcon`, `AuthoringMode`, `SelectionActions`, `actionStates`, `onCandidate`, `copyRepSummary`, `'copy-rep-summary'`, async/token staleness machinery; fast-pathed `autoConfirm` directly to `controller.confirmSelection(candidate)` (Pass 2).
- `src/lib/playbook/validators.ts`: Exported `textTrigger`; switched `buyerExplanation.trigger` to `textTrigger`; made `repInstruction.instructions` required.
- `src/lib/playbook/model.ts`: Re-exported `TextSourceTarget`; exported `TextTrigger`.
- `src/lib/playbook/structure.ts`: Made `DetailIdentity.currentRevisionId` required `Id<'playbookItemRevisions'>`.
- `src/lib/playbook/content.ts`: Made `semanticTarget<T extends SourceTarget>(target: T): T` generic; changed `semanticInstructions` to always return `Instructions` omitting blank (`!text.trim()`) entries; simplified `semanticRepInstruction` to always emit `instructions`.
- `src/lib/playbook/validation.ts`: Changed `validateStructuralReplacementContent` error text to `'A structural concession needs text or a reference.'`; in `validateTemplateItemContent`, dropped redundant buyer `target.kind !== 'text'` check, invoked `validateStructuralReplacementContent(item)` for `rep`, rejected present blank `instructions[key]` (`'Instruction fields cannot be blank'`, Pass 2), and enforced uniform non-empty rep rule (`'Add instructions, approval guidance, or a concession before saving.'`).
- `src/lib/playbook/audit.ts`: Removed redundant `validateStructuralReplacementContent` import and call.
- `src/lib/playbook/document-overlay.ts`: Narrowed `filterOverlappedExplanations` to `<T extends { trigger: TextTrigger }>`; removed dead `!isTextTarget(target)` guard.
- `src/lib/contract/persisted-values.ts`: Required `instructions(value.instructions)` (removed `value.instructions === undefined ||`).
- `src/lib/playbook/template-copy.ts`: Deleted `creationTitle` from both audiences; required `audience: TemplateAudience` in `templateCopy(audience)`.
- `src/lib/playbook/draft.ts`: Exported `BuyerExplanationDraft`; required `audience` on `newTemplateDraft` with overloads (`'buyer'` requires `TextSourceTarget`, `'rep'` accepts `SourceTarget`).
- `src/lib/playbook/source-picking.ts`: Deleted `AuthoringMode`, `ActionEligibility`, `SelectionActions`, `selectionActions()`, unused `structuralBoundary` import; flattened `SelectionEligibility` to `{ allowed: true } | { allowed: false; issue: SelectionIssue }`; added `'text-required'` & `'concession-boundary-conflict'` to `SelectionIssue`; required `audience` in `selectionIssueMessage` and `evaluateInitialSelection`; changed `evaluateConcessionAddition` signature to `(index, trigger, persistedId, geometry, context)` and mapped `GeometryError('trigger-boundary')` to `'concession-boundary-conflict'`; removed unused default arg on `evaluateSecondarySelection`.
- `src/lib/playbook/authoring-context.svelte.ts`: Replaced `Workflow` union with `ConcessionDraft | null`; removed `workflow` constructor arg & required `audience`; added narrowed `buyerTrigger`/`normalizedBuyerTrigger`; updated `persistedDirty` to normalize rep instructions on both sides and buyer blank-only explanation (Pass 2); replaced imperative `validateGeometry` with two private `$derived` validators (`validateGeometry`, `validateComposerGeometry`, Pass 2); added `proposedConcessionPayload` and `concessionValidation` (deleted `composerLimitReason` / `stagedPayload`).
- `src/lib/playbook/authoring-controller.svelte.ts`: Required `audience`; deleted `startConcessionFromSelection`, `beginNewConcessionAt`, `setConcessionTier`, `dismissFromOutside`, `workflow`, `creating`, `composing`, `stagedCreation`, `additionTargetReason`, `primaryAction.isError`, `creationIncomplete`, `canCancel`, duplicate `dirty`/`locationPicking`, `{ kind: 'cancel' }` transition; added `concessionComposer`, `addingConcession`, `selectionSource()` (Pass 2), keystroke-free `concessionAdditionReason` (shared by `addConcession`, Pass 2), `confirmSelection`; allowed add/remove concessions on unsaved drafts; unified `cancel()`; removed imperative `context.validateGeometry` assignment in `accept()`, stale `"or creation"` copy, and dead `unsavedWorkMessage` fallback (Pass 2).
- `src/lib/playbook/save-transport.ts`: Required `audience: TemplateAudience` in `convexSaveTransport`; passed required `audience` to `deleteTemplateItem`.
- `src/lib/playbook/template-authoring-session.svelte.ts`: Required `audience: TemplateAudience` on constructor `options`, `setTemplateAuthoringSession`, and `getTemplateAuthoringSession`; deleted all `?? 'rep'` fallbacks.
- `src/lib/auth/WorkspaceScope.svelte`, `src/lib/auth/Workspace.svelte`, `src/lib/auth/WorkspaceShell.svelte`, `src/lib/components/chrome/WorkspaceSaveStatus.svelte`: Passed explicit `'rep'` to session constructor/setter/getters.
- `src/lib/components/playbook/BoxDismissal.svelte`: Added `dismissOnOutsidePointer = true` prop (Pass 2).
- `src/lib/components/workspace/TemplateWorkspace.svelte`: Required `audience`; deleted all Convex imports (`useQuery`, `useConvexClient`, `api`, `SelectionCandidate`), `membershipId`, `client`, `copyCandidate`, `copyTarget`, `copySource`, `repSummary`, `copyRepSummary`; passed `allowBoundarySelection={!buyerTemplate}`; collapsed `cancel()` into `dismiss(true)` and wired `editor?.focusAddConcession(returnTier)` in `runEditorAction`, `dismissOnOutsidePointer={!locationPicking}`, and `onDocumentBackground={locationPicking ? undefined : () => dismiss(false)}` (Pass 2); simplified `<SourceSelectionToolbar>` props.
- `src/lib/components/playbook/ConcessionCreationEditor.svelte`: Removed `Popover`, `CaretDownIcon`, `onTier`, `Options` dropdown, and rare checkbox; rendered inline `<Checkbox>` directly.
- `src/lib/components/playbook/PlaybookEditor.svelte`: Collapsed to unified instructions box + concession sub-step; tier-specific Step 1 header; 3-dot Delete gated on `!addingConcession && draft.persistedId`; wrapped Add concession buttons in disabled `<Tooltip>` with `controller.concessionAdditionReason`; replaced `previousFocusState` `$effect` with explicit `startConcession`, `cancelLocation`, exported `focusAddConcession`, narrowed `focusCreationField` to `'textarea'`, and made tooltip `role="group"`/`aria-label` conditional (Pass 2).
- `src/lib/components/playbook/PlaybookReadBody.svelte` & `src/lib/components/playbook/RepPlaybookPanel.svelte`: Removed `?.` on `item.instructions`.
- `src/lib/components/ui/modal/help-content.ts`: Reduced `buyer-template` to 2 steps (removed `"Start from rep wording"`); rewrote `template` steps for single-button **Add instructions** + in-editor concessions.

#### `src/routes/` (0 files)
- None touched. (`/template/+page.svelte` and `/template/buyers/+page.svelte` render `<DocumentBody requiresTemplate>`; `Workspace.svelte` already mounts `<TemplateWorkspace audience="rep" />` and `<TemplateWorkspace audience="buyer" />`.)

#### `scripts/` (3 files)
- `scripts/production-seed.mjs`: Filtered blank instruction values (`Boolean(old[key]?.trim())`) when building `instructions` from export.
- `scripts/reconcile-production-seed.mjs`: Updated `new AuthoringContext(item, saved, 'rep')`; dropped `?? {}` and `?.` on `item.instructions` (Pass 2).
- `scripts/verify-seed-data.mjs`: Replaced tautological `i.instructions &&` with `hasInstructions(i)` checking non-blank values (Pass 2).

#### `tests/` (9 files — existing fixture maintenance only; no new tests)
- `tests/support/contract-data.ts`: Added `instructions: {}` to `item`.
- `tests/support/document.ts`: Added `currentRevisionId: 'rev-...'` to `records`.
- `tests/components/contracts/fixtures.ts`: Added `instructions: {}` to rep item fixture.
- `tests/backend/contracts/saving.test.ts`: Dropped `!` on `saved.currentRevisionId`; added required `headReadBytes: 0`, `structureResultBytes: 0`, `authoringGeneration: 1`, `structuralGeneration: 1` to synthetic `templateVersions` insert.
- `tests/backend/contracts/creation.test.ts`: Added `audience: 'rep'` to all four `api.playbookItems.deleteTemplateItem` calls.
- `tests/components/authoring/authoring-panel-snappiness.test.ts`: Deleted `vi.mock('convex-svelte')` and hoisted `context`; passed `audience: 'rep'` to `TemplateAuthoringSession`.
- `tests/components/authoring/AuthoringSnappinessHarness.svelte`: Passed `audience="rep"` on `<TemplateWorkspace />`.
- `tests/components/viewer/SnappinessContext.svelte`: Passed `'rep'` to `setTemplateAuthoringSession(authoring, 'rep')`.
- `tests/components/authoring/authoring-snappiness.test.ts`: Passed `audience: 'rep'` in `fixture()`; dropped `?.` on `draft.instructions`.

#### `docs/` (2 files)
- `docs/floating-ui.md`: Removed `Popover` references.
- `docs/template-authoring-storage.md`: Removed `Copy rep summary`/`repSummary` and stale G19/G20 legacy conversion notes; documented `by_companyId_and_audience`, required `audience` args, `textTrigger`, required non-blank `instructions`, required version/revision/receipt fields, and pure `{ companyId, versionId }` `currentTemplate` pointer (Pass 2).

---

## 3. Intentional Design Decisions & Non-Obvious Invariants ("Why It Is This Way")

1. **Why `itemHeadFields.currentRevisionId` is STILL `v.optional(...)` on `playbookItems` while `detailFields.currentRevisionId` is required:**
   In `src/convex/playbookItemRevisions.ts:215-245` (`createAuthoringItem`), Convex requires an allocated `Id<'playbookItems'>` before inserting `playbookItemRevisions` (which references `itemId: v.id('playbookItems')`). So `createAuthoringItem` inserts a transient placeholder head with `structure: new ArrayBuffer(0)` and no `currentRevisionId`, inserts the revision, and immediately `ctx.db.replace`s the head in the same mutation transaction. Keeping `itemHeadFields.currentRevisionId` optional on the table schema while required on `TemplateDetailRecord` / `hydratedTemplateItem` is required by that atomic two-step insert.
2. **Why `templateVersions.validation` stays `v.optional(...)`:**
   `src/convex/templateSourceFormatting.ts:116-120` and `src/convex/authoringMigration.ts:135-139` intentionally patch `validation: undefined` to invalidate authoring certification during source repairs until recertification finishes.
3. **Why `currentTemplate` drops `authoringGeneration` / `structuralGeneration` and skips writes on mutable updates:**
   Nothing in the repo reads those columns off `currentTemplate`; `templateVersions` owns them. Because `playbookItems.currentStructure` (`observation()`) reads `templateVersions` via `db.get(pointer.versionId)`, Convex still reactively invalidates `currentStructure` when a mutable version is replaced in place — while skipping `db.replace('currentTemplate', ...)` eliminates a wasted write and avoids spuriously invalidating `templates.current` on every template edit.
4. **Why `UnrevisedDetailRecord` uses `HistoricalItem & Pick<...>` instead of `Omit<TemplateDetailRecord, 'currentRevisionId'>`:**
   `TemplateDetailRecord` distributes over the discriminated union `RepInstruction | BuyerExplanation`. Non-distributive `Omit<A | B, K>` collapses union-specific fields (dropping `explanation` / `concessions`), breaking typechecking. Expressing `UnrevisedDetailRecord` via `HistoricalItem & Pick<TemplateDetailRecord, 'renderKey'> & Partial<Pick<TemplateDetailRecord, 'lastOperation'>>` preserves the union and deduplicates three function signatures in `src/convex/playbookItemRevisions.ts:12-14`.
5. **Why `SourceSelectionToolbar.confirm()` captures `const selection = current()` BEFORE calling `controller.confirmSelection(candidate)`:**
   `controller.confirmSelection(candidate)` opens the editor synchronously, flipping `authoring.textSelectionEnabled` (the toolbar's `enabled` prop) to `false`. Calling `current()` afterward would return `undefined` and leave the native/DOM text selection painted behind the open panel.
6. **Why `evaluateConcessionAddition` takes `(index, trigger, persistedId, geometry, context)` instead of `RepInstructionDraft`:**
   `src/lib/playbook/authoring-controller.svelte.ts:229-243` computes `currentConcessionAdditionReason` as a Svelte `$derived.by`. Passing only `context.trigger`, `context.confirmed?._id`, and `context.geometryVersion` ensures typing in Summary/Instructions/Approval/Concessions never triggers geometry validation on keystrokes (preserving the snappiness budget tested by `authoring-snappiness.test.ts`).
7. **Why `SelectionSurface` still indexes `this.breaks` / `#breaks` / `#pageBreaks` when `allowBoundarySelection === false`:**
   Multi-paragraph text drags on `/template/buyers` still cross paragraph breaks represented as `BreakOccurrence` entries in `SelectionDocument`. Gating only `this.surface.breakAt(page, y)` in `DocumentSelectionController.#hit()` and `pureBreak` in `SelectionSurface.resolve()` prevents pure-gap selection (mouse and keyboard) without breaking cross-paragraph text selection.
8. **Why `AuthoringContext` has TWO `$derived` `createDraftValidator()` instances (`validateGeometry` and `validateComposerGeometry`):**
   `src/lib/playbook/geometry-index.ts:304-328` memoizes only a single `previous` key string per validator closure. Sharing one closure between `geometryReason` (`this.concessions`) and `composerGeometryReason` (`[this.concessionDraft.concession]`) thrashes its single-slot cache whenever both evaluate.
9. **Why `src/lib/playbook/structure-codec.ts:64-65` keeps its runtime buyer-boundary check despite `buyerExplanation.trigger = textTrigger`:**
   `decodeStructure` decodes raw `ArrayBuffer` bytes from `playbookItems.structure` where TypeScript/Convex validators cannot guarantee integrity of binary payloads.
10. **Why `committed()` and `observation()` are split in `src/convex/playbookItems.ts`:**
    Mutations (`saveTemplateItem`, `deleteTemplateItem`) only return the 4-field watermark (`templateSourceId`, `templateSourceFingerprint`, `authoringGeneration`, `structuralGeneration`) and don't need `ready`; splitting `committed()` avoids reading `templateSourceCertificates` on every save/delete response.
11. **Why focus restoration in `PlaybookEditor` is imperative (`startConcession`, `cancelLocation`, `editor?.focusAddConcession(returnTier)`) instead of a `$effect`:**
    A reactive `$effect` observing `concessionDraft` becoming `null` cannot distinguish in-panel **Add**/**Cancel**/`Escape` from an outside pointer click (`BoxDismissal` `outside-pointer`) or remote conflict adoption (`useSaved`), causing focus theft away from outside controls (violating `docs/floating-ui.md:97`).
12. **Why `WorkspaceRouteFrame.svelte` and `DocumentHeading.svelte` retain optional `audience?: TemplateAudience`:**
    Both components also serve `kind="saved"` and `kind="buyer"` contract routes where `TemplateAudience` does not apply.

---

## 4. Exact Behavioral & Data-Flow Semantics Changed

### Read/Write Paths & Projections
- **`playbookItems.currentStructure({ membershipId, audience })`:** Requires explicit `audience`. Queries `playbookItems` via `by_companyId_and_audience`, validates count/order/revisionId/audience against `version.items.filter(ref => ref.audience === audience)` via `orderedAudienceHeads`, and decodes only that audience's heads (`headStructure` asserts `decoded.audience === head.audience`).
- **`playbookItems.content({ membershipId, id, audience })`:** Requires explicit `audience`; checks `head.audience !== audience` before calling `hydrateHead` (no binary decode on cross-audience ID probe).
- **`playbookItems.saveTemplateItem`:**
  - Checks `head.audience !== item.audience` before reading `playbookItemRevisions` on both creation-receipt replay (L195) and normal updates (L224).
  - Runs `validateTemplateItemContent(item)` (enforcing structural replacement content, no blank present `instructions[key]`, and non-empty rep item invariant).
  - Structural saves (`structuralChanged === true`) call `validateStructure` which reads `readValidationFacts(ctx, templateSource, captured.certificate)` and queries only `item.audience` heads via `by_companyId_and_audience` + `orderedAudienceHeads`.
  - Updates `templateVersions` in place when mutable **without** rewriting `currentTemplate` (Pass 2). Only frozen-version transitions / initial saves write `currentTemplate` (`{ companyId, versionId }`).
- **`playbookItems.deleteTemplateItem({ membershipId, id, audience, expectedContentRevision })`:** Requires `audience`; throws `'This item is unavailable.'` if `head.audience !== audience` before reading revisions. Idempotent on already-deleted item (`!head` returns `{ status: 'deleted', ...committed }`).
- **`playbookItems.repSummary`:** Deleted completely (previously allowed `/template/buyers` to read rep summaries for overlapping ranges).
- **`accounts.hasRepInstructions`:** Changed from scanning up to `MAX_PLAYBOOK_ITEMS + 1` rows on `by_companyId` + decoding binary `structure` to `.withIndex('by_companyId_and_audience', (q) => q.eq('companyId', companyId).eq('audience', 'rep')).first()`.

### Deletion & Cleanup Lifecycles
- **Unchanged:** Single-contract delete, account deletion, company deletion (`companyDeletion.ts` drains `playbookItems`, `playbookItemRevisions`, `playbookItemCreationReceipts`, `templateVersions`, `currentTemplate`, `authoringMigrations` using `by_companyId` — which was deliberately kept alongside `by_companyId_and_audience`), scheduled jobs, crons, `_storage` cleanup, HubSpot/Loops/Cal integrations.
- **Live item delete (`deleteTemplateItem`):** Still deletes live `playbookItems` row and deletes mutable-only revision if `revision.mutableVersionId === captured.version._id`; historical frozen versions remain readable.

### Auth / Authz & Validation Boundaries
- Buyer `currentStructure` and `content` still require `requirePermission(ctx, 'manageTemplate', membershipId)` (admin-only); rep reads require `requireMembership`; mutations require `manageTemplate`.
- Cross-audience IDs: `content` returns `{ status: 'missing' }`, `deleteTemplateItem` throws `Error('This item is unavailable.')`, `saveTemplateItem` returns `{ status: 'rejected', message: 'The template item audience cannot change.' }`.
- **New validation rejections (`PlaybookValidationError`):**
  - Rep item with all instruction fields blank/absent, `approvalPolicy.kind === 'none'`, and `concessions.length === 0` → `'Add instructions, approval guidance, or a concession before saving.'`
  - Rep item with any present `instructions[key]` whose `.trim()` is empty → `'Instruction fields cannot be blank'` (Pass 2 — **note:** breaks current `data/convex/playbookItems.jsonl` until regenerated).
  - Boundary target on `buyerExplanation` → rejected at Convex argument validator (`textTrigger`), selection layer (`allowBoundarySelection={false}`), and `evaluateInitialSelection` (`'Select the text you want to explain to buyers.'`).
  - Boundary change with empty replacement on primary OR secondary concession change → caught inside `validateTemplateItemContent` via `validateStructuralReplacementContent` (`'A structural concession needs text or a reference.'`), both client-side (on **Add** and **Save**) and server-side.
  - Text trigger spanning an existing structural boundary trigger → `evaluateConcessionAddition` translates `GeometryError('trigger-boundary')` to `'concession-boundary-conflict'` (`"Concessions can't be added when the highlighted text spans an existing insertion point."`), proactively disabling **Add a concession** / **Add a rare concession** with a tooltip.

### Frontend ↔ Backend Contract Changes (Breaking — Requires DB Reset)
- **Convex API:** `api.playbookItems.repSummary` removed; `audience` now required on `api.playbookItems.deleteTemplateItem`, `api.playbookItems.currentStructure`, `api.playbookItems.content`; `item.instructions` required on `repInstruction`; `item.trigger.target` restricted to `textSourceTarget` on `buyerExplanation`.
- **Convex DB schema:** `playbookItems` requires top-level `audience` + index `by_companyId_and_audience`; `currentTemplate` forbids `authoringGeneration`/`structuralGeneration` (Pass 2); `templateVersions`, `playbookItemRevisions`, `playbookItemCreationReceipts` require previously optional fields.
- **Client cache / IndexedDB (`workspace-read-storage.ts`):** Keys/versions unchanged (`dinu:workspace-read:v1:...`), **but** any cached `templateDetails` entry written before this deploy missing `instructions` or `currentRevisionId` will fail `persisted-values.ts` guards (for `instructions`) or mismatch `TemplateDetailRecord` expectations; IndexedDB entries are disposable and naturally invalidated on fingerprint/source reset after DB re-seed.

---

## 5. Compromises, Leftovers & Unfinished Simplifications

1. **BLOCKER — `data/convex/playbookItems.jsonl` (and `data/migration/{mapping,reconciliation}.json`) NOT YET REGENERATED:**
   Because the shell runner died with exit `137` before `npm run seed:restore-export && npm run seed:reconcile` could execute, `data/convex/playbookItems.jsonl` **still contains `"howToExplainToBuyers": "", "commonObjections": "", "negotiation": ""` on all 55 rows**. Under Pass 2's `validateTemplateItemContent`, `npm run seed:verify` and `npm run convex:seed` **will fail** until `npm run seed:restore-export` and `npm run seed:reconcile` are run.
2. **BLOCKER — All Pass 2 edits are uncompiled, unformatted, and untested:**
   Every edit labeled `(Pass 2)` above has NOT been checked by `svelte-check`, `tsc`, Prettier, Vitest, or `vite build` because `run_command` exited `137`.
3. **`src/lib/contract/persisted-values.ts:215-218, 229, 241`:**
   - `instructions()` checks `value[key] === undefined || text(value[key])` — does NOT reject blank strings `""`/`"   "`, lagging behind `validateTemplateItemContent`.
   - Line 241 redundantly calls `sourceTarget(value.trigger.target)` which was already checked at line 229.
4. **`src/lib/playbook/authoring-controller.svelte.ts:448-456` (`setApprovalGuidance`):**
   Eagerly coerces whitespace-only input to `{ kind: 'none' }` on every keystroke (typing Spacebar in an empty approval guidance `<TextArea>` snaps back to `""`), whereas `setInstruction` and `setExplanation` preserve raw input in `content` and normalize in `persistedDirty` / `payload`.
5. **`src/lib/playbook/validation.ts:132-137` — server concession validation gaps (pre-existing, kept):**
   `validateTemplateItemContent` does NOT check `!concession.description.trim()` or `concession.changes.length === 0`. Deliberately untouched because existing test fixtures (`tests/support/contract-data.ts`, `tests/support/document.ts`, `tests/components/contracts/fixtures.ts`) use synthetic `changes: []` concessions.
6. **Leftover defensive optional fallbacks on now-required fields:**
   - `src/lib/components/playbook/RepPlaybookPanel.svelte:31,66`: `item.approvalPolicy.instructions ?? ''` and `concession.tier ?? 'preferred'`.
   - `src/lib/playbook/template-authoring-session.svelte.ts:436`: `record.renderKey ?? old?.renderKey` (`record.renderKey` is always `string`).
   - `src/lib/playbook/model.ts:30`: `RepInstructionRecord.renderKey?: string` kept optional because immutable snapshot/historical callers construct `RepInstructionRecord` without `renderKey`.
7. **Duplicated disabled-button `<Tooltip>` wrapper:**
   `src/lib/components/playbook/PlaybookEditor.svelte:290-316` and `L342-367` (and `src/lib/components/workspace/RepWorkspace.svelte:950-995`) still repeat the same `<Tooltip standalone={false}><span ...><button disabled=...>` pattern; `RepWorkspace.svelte` still sets `role="group"` / `aria-label` unconditionally when enabled.
8. **Conservative read-capacity check in `src/convex/playbookItems.ts:134`:**
   `validateStructure` budgets `version.headReadBytes` (both audiences combined) even though it only reads one audience via `by_companyId_and_audience`. Safe (upper bound), not tightened to per-audience head bytes.
9. **`templateGenerations(version, pointer)` signature in `src/convex/templates.ts:213-223`:**
   Still takes `pointer` solely to assert `version._id !== pointer.versionId`, even though generations are read exclusively from `version`.
10. **Convex codegen not re-run via CLI:**
    `npx convex codegen` failed in sandbox (`ENOTFOUND o1192621.ingest.sentry.io`). Because `api.d.ts` and `dataModel.d.ts` derive types from `../schema.js` and existing module imports, `svelte-check` accepted them, but Convex CLI schema/function bundling (`npx convex dev` / `npx convex deploy`) has NOT been run.
11. **Prettier formatting:**
    37 pre-existing files outside this refactor fail global `npm run format:check`; the 15 files modified in Pass 2 have not been Prettier-formatted yet.

---

## 6. Verification, Test Changes & Blind Spots

### Commands Run & Exact Status

| Check | Pass 1 Result | Pass 2 Result (Current Disk State) |
|---|---|---|
| `npm run check` (`svelte-kit sync && svelte-check && check:tools`) | **PASSED** (0 errors, 0 warnings) | **NOT RUN** (exit `137`) |
| `npm run test:ssr` | **PASSED** (3/3 files, 16/16 tests) | **NOT RUN** (exit `137`) |
| `npm run test:backend` | **PASSED** (16/16 files, 105/105 tests) | **NOT RUN** (exit `137`) |
| `npm run test:client` | **PASSED** (4/4 files, 21/21 tests) | **NOT RUN** (exit `137`) |
| `npm run test:components` | **PASSED** (23/23 files, 158/158 tests) | **NOT RUN** (exit `137`) |
| `npm run test:perf` | **PASSED** (7/7 files, 38/38 tests; note 1 pre-existing same-ms `Date.now()` flake in `saving.test.ts:253` `directoryWrites: 0` vs `1` on an earlier run) | **NOT RUN** (exit `137`) |
| `npm run build` + `npm run verify:loading-bundles` | **PASSED** | **NOT RUN** (exit `137`) |
| `npx prettier --check` (our edited files) | **PASSED** (Pass 1 files) | **NOT RUN** (Pass 2 files unformatted) |
| `npm run seed:verify` | **FAILED** (`Edit/save loses data: 0` — stale `playbookItems.jsonl`) | **NOT RUN** (exit `137`; `playbookItems.jsonl` still stale) |
| `npx convex codegen` / `npx convex dev` | **FAILED** (network blocked in sandbox) | **NOT RUN** |

### Test Changes Made (Zero Tests Deleted or Weakened)
Per project rules (`AGENTS.md`), no new tests were added and no assertions were deleted or weakened. Only fixture/wiring updates for breaking type/signature changes:
- Added `instructions: {}` in `tests/support/contract-data.ts` and `tests/components/contracts/fixtures.ts`.
- Added `currentRevisionId` in `tests/support/document.ts`.
- Added required `headReadBytes`/`structureResultBytes`/`authoringGeneration`/`structuralGeneration` and dropped `!` on `currentRevisionId` in `tests/backend/contracts/saving.test.ts`.
- Passed `audience: 'rep'` to 4 `deleteTemplateItem` calls in `tests/backend/contracts/creation.test.ts`.
- Passed `audience: 'rep'` / `audience="rep"` in `AuthoringSnappinessHarness.svelte`, `SnappinessContext.svelte`, `authoring-snappiness.test.ts`, and `authoring-panel-snappiness.test.ts`; deleted the now-unused `vi.mock('convex-svelte')` mock in `authoring-panel-snappiness.test.ts` (since `TemplateWorkspace.svelte` no longer calls `useQuery`/`useConvexClient`).

### Unverified Flows & Blind Spots
- **Every Pass 2 edit** (`currentTemplate` column removal, `BoxDismissal.dismissOnOutsidePointer`, `TemplateWorkspace` `bind:this={editor}` + `focusAddConcession`, `AuthoringContext` `$derived` geometry validators, `AuthoringController.selectionSource()`, `SourceSelectionToolbar` `autoConfirm` fast-path, `validation.ts` blank-instruction rejection, `operator.ts` compactHead measurement, `authoringMigration.ts` audience check) has **zero test/typecheck execution yet**.
- **All browser/DOM interactions** (no Playwright or manual browser testing performed per `AGENTS.md`):
  - Buyer `/template/buyers` dragging across paragraph gaps vs. within/across multiple paragraphs (`allowBoundarySelection={false}`).
  - Rep `/template` paragraph-gap instructions-only bookmark save & re-open, and adding/previewing/deleting concessions before saving.
  - Step 2 (`locationPicking`) clicks on page background, gray page gutter, scrollbar, and `Escape` vs **Cancel location** vs **Cancel**.
  - Focus transitions (`focusCreationField`, `startConcession`, `cancelLocation`, `focusAddConcession` via **Add**/**Cancel**/`Escape`, and non-theft on outside pointer click).
  - Proactive disabled tooltip on **Add a concession** / **Add a rare concession** when text trigger spans an existing structural boundary trigger.
- **Convex live deployment & DB cutover:** pushing tightened schema + new `by_companyId_and_audience` index, nuking DB, regenerating `playbookItems.jsonl`, and running `npm run convex:seed`.
- **Concurrent editing / conflict recovery:** remote update arriving while `addingConcession` is open, or while typing spaces in a clean draft (`setInstruction` → `reconcile()`).

---

## 7. Where an Adversarial Reviewer Should Look First

1. **`src/lib/components/workspace/TemplateWorkspace.svelte:328-344, 554-560, 640-647, 691` + `src/lib/components/playbook/PlaybookEditor.svelte:74-99` (Unverified Pass 2):**
   Verify `let editor = $state<PlaybookEditor>()` with `bind:this={editor}` inside `{#snippet panelContent()}` compiles cleanly under `svelte-check`, and trace `runEditorAction` when `authoring.primary()` clicks **Add** vs **Save** vs `Escape` (note: `runEditorAction` does not currently guard `authoring.entry === openedEntry` across `await tick()` before calling `editor?.focusAddConcession(returnTier)`). Also verify `BoxDismissal` with `dismissOnOutsidePointer={!locationPicking}` doesn't interfere with clicking a nav link or UtilityRail button during Step 2.
2. **`src/convex/templates.ts:313-339` + `src/convex/schema.ts:321-325` (Unverified Pass 2):**
   Verify removing `authoringGeneration`/`structuralGeneration` from `currentTemplate` and skipping `db.replace('currentTemplate', ...)` on mutable version saves doesn't break any reactive subscription, `templateSourceFormatting.ts`, `authoringMigration.ts`, or backend test (`creation.test.ts`, `saving.test.ts`, `startup.test.ts`, `reconcile-production-seed.mjs`).
3. **`src/lib/playbook/validation.ts:138-148` + `data/convex/playbookItems.jsonl` (Known Broken Until Seed Regenerated):**
   Rejecting blank present `instructions[key]` will fail any test fixture, seed file, or direct Convex mutation that passes `{ summary: '' }`. Run `npm run seed:restore-export && npm run seed:reconcile && npm run seed:verify` and verify no test in `tests/` passes blank instruction strings.
4. **`src/lib/playbook/authoring-context.svelte.ts:73-74, 138-157, 220-235` (Unverified Pass 2):**
   Check Svelte 5 `$derived` semantics for `private validateGeometry = $derived(this.geometry?.createDraftValidator() ?? null)` inside a `.svelte.ts` class — specifically ensure `validateGeometry` / `validateComposerGeometry` preserve memoization across keystrokes (i.e. `this.geometry` reference stays stable when `geometryVersion` doesn't change, and `geometryVersion` bumps don't recreate the closure needlessly, only re-run `checkGeometry`). Also check `persistedDirty` for buyer explanations when editing a saved explanation from `"foo"` to `"   "` (dirty = `true`, Save disabled with `'Explanation cannot be blank'`) vs a new explanation from `""` to `"   "` (dirty = `false`).
5. **`src/lib/playbook/authoring-controller.svelte.ts:216-243, 606-632` (Unverified Pass 2):**
   Check `currentConcessionAdditionReason` when `canEdit === true` and `!this.selectionSource()`: returning `'Wait for the current template'` disables **Add a concession** while `viewer.interactionEnabled` is false. Verify this doesn't flicker or permanently disable the button in headless component tests (`authoring-snappiness.test.ts` / `authoring-panel-snappiness.test.ts`) where `selectionContext` may be mocked or omitted.
6. **`src/lib/components/document/SourceSelectionToolbar.svelte:75-87` (Unverified Pass 2):**
   In the `autoConfirm` fast-path (`if (autoConfirm) { const selection = getDocumentSelection(container); if (controller.confirmSelection(candidate)) selection?.clear(true); return; }`), verify that when `confirmSelection(candidate)` returns `false` (invalid secondary location), the error issue/warning is properly reported by `attachSecondaryLocation` → `requireSelection` and whether the invalid DOM selection should stay or clear.
7. **`src/convex/operator.ts:330-355` (Unverified Pass 2):**
   Verify `encodeStructure(playbookStructure(item))` inside `bootstrap` works for every item shape (`rep` and `buyer`, boundary and text targets) and that `assertStorageCapacity` byte budgets still accurately cover `createAuthoringItem`'s two head writes (`initialHead` insert + `packedHead` replace) plus `contentRevision` insert.
8. **`src/lib/document/selection/document-selection.ts:201-213` + `src/lib/document/selection/selection-surface.ts:456-459`:**
   Verify on `/template/buyers` (`allowBoundarySelection = false`) that clicking/dragging inside a paragraph gap snaps to text cleanly without creating a zero-length or reversed extent, and that triple-clicking or Shift+Arrow keyboard selection across paragraphs does not silently return `null` unless the extent is a pure break.
9. **`src/convex/playbookItems.ts:126-159, 385-415` + `src/convex/templates.ts:759-797`:**
   Verify `orderedAudienceHeads` + `by_companyId_and_audience` in `validateStructure` and `currentStructure` maintains exact manifest ordering, rejects duplicate/stale/mismatched-audience heads, and never allows an audience's item count to silently bypass `MAX_PLAYBOOK_ITEMS` (total company count is still checked via `captured.version.itemCount >= MAX_PLAYBOOK_ITEMS` in `saveTemplateItem:252`).
