# Commenting integration remediation

Scope: implement the 12 verified findings and six steps in `/tmp/oceans-commenting-integration-audit-ulkxmv18/final-report.md`. Preserve unrelated working-tree edits and shared buyer-link copy feedback. No new tests or browser checks.

Decisions: reuse action-neutral selection toolbar/floating machinery with discussion-specific anchors; preserve uncertain operation IDs and authors; use native Convex creation time for message DTOs; retain compatibility for existing timestamp fields without deploying.

Progress:
- Audit complete: all 12 independently verified.
- Local implementation complete. All 12 findings addressed in code; Q-09 retains an optional legacy field for existing rows.

Remaining: user visual/native-browser checks. Optional future deployed-data cleanup can remove legacy stored timestamp values and then remove the optional field.

Verification: existing performance and targeted lifecycle suites passed; final type/tool checks and production build passed. Runtime selection/focus, cookie/account races, exact query counts and visual appearance remain unverified. No deployment performed.

Implementation checkpoint:
- Q-06: whole-selection envelope rejects unsupported table text/intervening tables; shared reader scopes traversal to the selected ancestor.
- Q-07/Q-12: buyer identity bootstraps after the initial accepted read; definitive refusals/pre-dispatch failures retire operations, while uncertain retries retain operation ID/author and uncertainty history. Operation map is reactive for recovery admission.
- Q-01/Q-05: both existing and discussion actions use SelectionToolbar, FloatingSurface, Tooltip and SquareIconButton. Discussion panel owns menus/protected rail and defers Escape to focused composers.
- Q-02/Q-03/Q-04/Q-10/Q-11: composers use shared TextArea/Button, retain native focus/autosize via one attachment, share the server's 20,000-character bound, use existing card surfaces, and mark Delete dangerous.
- Q-08: latest reply subscription waits for an accepted first history page that is not complete.
- Q-09: new messages no longer store createdAt; DTOs still use _creationTime. Legacy field is optional so existing populated data remains valid. Removing old stored values and tightening the schema remains a deployment/data cleanup, not part of this local change.

Validation checkpoint: test:perf 37/37; existing selection-gesture and loading-recovery files 12/12; svelte/tool checks clean; production build passed. The final type/build round also passed (zero Svelte errors or warnings). No tests added/edited, browser checks, data mutations or deployments.


Automated guarantees checked:
- `npm run test:perf`: 37 checks passed for existing saving/replay/cost, scheduling, cache and related platform guarantees.
- Existing `selection-gesture.test.ts` and `loading-recovery.test.ts`: 12 checks passed for native selection ownership/final capture, bounded reads and discussion access revocation, and shared clipboard-feedback lifetime.
- `npm run build`: final Svelte/types/tool checks and production compilation passed. `git diff --check` clean for affected files.

These suites do not directly assert the new discussion operation/refusal transitions, initial viewer bootstrap, latest-reply subscription counts, shared-widget clipping, or mobile Escape/focus behavior. Those changes were reviewed statically; no test coverage was added or expanded. Browser/native focus and selection, account/cookie races, and appearance remain manual checks. Backend validator changes were compiled locally; deployment/schema acceptance and old-data cleanup were not exercised.

Evidence logs: `/tmp/commenting-remediation-perf.log`, `/tmp/commenting-remediation-lifecycle.log`, `/tmp/commenting-remediation-check.log`, `/tmp/commenting-remediation-build.log`. No changes made to buyer-link copy feedback or its host/controller path; the existing clipboard-feedback lifecycle assertion passed. Unrelated pre-existing working-tree changes were preserved.

Follow-up audit remediation (2026-11-10):
- Scope: three verified findings in `/var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/oceans-commenting-fixes-audit-7kwd8x3x/final-report.md` (a separate Q-ID namespace from the original audit).
- Q-01: request errors carry authentication classification through failed account refresh and known nonanonymous 401 response parsing; only the current viewer consumer publishes that classification. Unrelated automatic transport errors retain ordinary retry behavior. Shared cookie ownership and operation certainty/original-author guards remain intact.
- Q-02: session retry captures feed failure state and only retries a failed/unauthorized feed; viewer-only recovery retains loaded pages. Membership reconnect behavior is preserved.
- Q-03: table checks inspect the selection's common ancestor and its intersecting descendants, preserving rejection inside tables and across empty tables without querying unrelated tables.
- Validation complete: `npm run build` passed Svelte checks (zero errors/warnings), tool type checks, and production compilation. Targeted Prettier and `git diff --check` passed. Log: `/tmp/commenting-followup-build.log`. No tests were added, expanded, or rerun; no browser checks or deployments. Native account/cookie recovery, subscription counts, and selection behavior remain unverified at runtime.

Remaining integration remediation (2026-11-10):
- Authorized scope: six integration gaps from the latest review and removal of redundant margin icons.
- Plan: use shared inline actions/icon buttons and card typography/error presentation; extract the existing panel rail so comments use its mobile sheet geometry and animation; use shared cards for scrolling/safe-area treatment; replace CSS Highlight registry and manual range hit testing with document highlight groups and gesture intents. Preserve multiple desktop cards, source/replacement anchors, drafts, account recovery, proposal application, pagination and accessible mobile navigation.
- Complete locally. No backend or buyer-link feedback changes in this pass. No new tests or browser checks. Shared highlight/gesture changes passed existing performance and targeted selection checks.

Integration completion checkpoint:
- Removed per-thread margin icons and the separate CSS Highlight registry (`discussions/highlights.ts`). Document highlight groups now paint comments/proposals, and shared document gestures resolve passage activation with native-selection and drag suppression. Comment cards remain keyboard-operable; the mobile View discussions and Previous/Next controls remain available. Proposal cross-outs use the shared page overlay and theme colours.
- Discussion-specific anchor resolution remains: it supports both source and generated replacement origins. Rail packing still supports multiple simultaneous desktop threads. Line geometry and hit testing now belong to the existing document controller; unmeasured offscreen entries use page anchors until shared viewport geometry is available. Only the selected discussion requests immediate geometry.
- Extracted `DocumentPanelRail` from `DocumentWorkspaceLayout`; existing panels and discussions share positioning, mobile viewport/chrome limits, animation and interaction protection. Discussion threads and composers use `PlaybookCard`, including safe-area padding, overscroll containment and responsive panel typography.
- Apply/pagination/retry/navigation/recovery actions use shared InlineAction; mobile close uses SquareIconButton. InlineAction also supports the existing recovery sign-in link. Recovery sits within the selected shared card instead of overlaying it with a separate rounded-lg box.
- Error text uses text-danger and composer errors are linked through aria-describedby. Transport/account failures are not incorrectly classified as invalid message input.
- Card activation participates in layer focus restoration while retaining its original viewer-loading admission. Drafts, proposal application, message operation/recovery logic and pagination are unchanged.
- Concurrent blue/green attachment work changed the same viewer/controller/theme files. Preserved its semantic paint kinds and removal of the unused trigger-measurement path; comments use buyer-attachment green, native selection retains its selection kind, and proposals keep grey/cross-out treatment. Shared document CSS now styles both attachment kinds. No backend or buyer-copy feedback edits in this pass.
- Existing test:perf passed 37/37; existing search-overlay-snappiness and selection-gesture checks passed 12/12. These check existing cache/saving/scheduling guarantees, viewport-limited geometry reuse, coalesced/idle hover work, unchanged selection notifications and native-selection ownership. They do not directly assert the new discussion adapter or mobile appearance. No tests added or expanded. Final `npm run build` passed after focus callback cleanup: zero Svelte errors/warnings, tool type checks and production/Vercel packaging successful. Targeted Prettier and affected-file `git diff --check` passed.
- No browser checks, deployments or data mutations. Appearance, touch/mobile focus and safe-area behavior, discussion passage navigation and proposal cross-outs remain manually unverified.
- Evidence: `/tmp/commenting-integration-finish-perf.log`, `/tmp/commenting-integration-finish-selection.log`, `/tmp/commenting-integration-finish-format.log`, `/tmp/commenting-integration-finish-build.log`. Start-of-pass file snapshots: `/var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/oceans-commenting-integration-finish-4h85km_h`. An earlier build compiled successfully but hit a transient missing generated file during Vercel packaging; a subsequent build passed. Final rebuild covering the focus callback cleanup also passed.

Reply lifecycle remediation (2026-11-10):
- Authorized scope: implement the refined plan for stranded reply editors and doubled spacing.
- Decisions: one transient reply editor with retained per-thread text/errors/pending writes; shared outside dismissal, local focus-leaving dismissal and Escape restoration to the message trigger; block reopening pending replies; remove reply wrapper top padding. Preserve new-comment outside behavior, editing, buyer-copy feedback and concurrent changes.
- In progress: implementation, then type/tool checks and required performance suite. No new tests or browser checks.
- Start-of-pass snapshot: /var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/oceans-reply-lifecycle-qh905db2
- Complete locally: reply visibility now uses one transient thread ID; changing selection or hiding/deactivating discussions clears it while drafts retain text/errors/pending state. Message edit state remains separate.
- Existing layer dismissal closes active replies on outside pointers without changing new-comment outside behavior. Focus leaving reply controls collapses the editor without restoring focus; textarea-to-Reply focus stays inside. Escape from either control returns to its actual message trigger. Shared Button now forwards an optional native onkeydown callback.
- Pending replies cannot reopen after dismissal; success closes only the submitting thread's editor and clears text only if unchanged. Failure keeps the draft/error without reopening or focusing another editor. Removed reply wrapper top padding; preceding message/proposal/pagination bottom spacing supplies the gap.
- Validation: npm run test:perf passed 7 files / 37 tests (existing saving/replay/cost, scheduling/cache guarantees); npm run check passed zero Svelte errors/warnings and tool type checks. Targeted Prettier and affected-file diff whitespace checks passed. No tests added/expanded, backend edits, deployments or browser checks.
- Source-reviewed transitions: outside click, internal/externally moving focus, Escape from textarea/Reply, message/highlight selection, mobile Previous/Next/Close, new-comment begin/cancel, hidden/deactivated panels, pending completion after switching/dismissal, retained draft/error reopening. Actual browser pointer/focus/mobile behavior and rendered spacing remain unverified.
- Evidence: /tmp/commenting-reply-check.log and /tmp/commenting-reply-perf.log. Preserved pre-existing edits; this pass touched six source files plus this progress note.

Sibling interaction remediation (2026-11-10):
- Authorized scope: fix all five findings from the sibling interaction review: overwritten create draft, stranded message editors, simultaneous mobile draft/thread, async create navigation override, reply retry pagination loss.
- Decisions: preserve the existing create draft and its anchor/type until Cancel or success; separate retained edit contents from transient editing visibility; activate/select the edited thread; collapse editors on selection/hiding/outside/focus leaving; keep mobile draft visibility aligned with selection and provide a way to resume it; only select a created thread if the submitting interaction still owns selection; use existing page retry while preserving reply subscription coordination.
- In progress: frontend implementation, source transition review, type/tool checks, required performance suite. No new tests or browser checks.
- Start-of-pass snapshot: /var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/oceans-commenting-sibling-fixes-3b2d8qt2
- Complete locally: new-comment actions resume the existing draft without replacing its text, passage, type or revision. Explicit Cancel still discards that draft; cancellation only clears selection if the draft owns it.
- Edit visibility now uses one transient message ID, separate from initialized retained text/revision/author/error/pending state. Edit selects its thread, replaces any reply/editor interaction, and closes on selection changes, outside pointer dismissal, focus leaving, or hidden/deactivated discussions. Cancel/Escape restore the message actions trigger after rendering; explicit Cancel/Escape discard the edit draft, preserving existing cancellation semantics. Focus moving between textarea/Save/Cancel stays within the editor. Save completion closes only its own editor; failures retain content/error without reopening it.
- New-comment cards follow the selected-card mobile visibility condition. Continue draft resumes and focuses a retained draft; focusing its desktop form also selects its owning card. Escape from either MessageComposer button is handled locally, with panel dismissal deferring to its composer wrapper.
- Create completion records the successful thread independently of navigation. Selection moves to it only while the original submitting selection still owns the interaction; otherwise the newer thread/reply/edit stays selected. A removed composer cannot leave a stale composer selection. Deactivation also invalidates that selection ownership.
- Reply retry now delegates to LiveDiscussionPages.retry and reconciles tail/own-message subscriptions without restarting the entire active reply state. Ordinary page timeouts preserve accepted pages/cursors; authorization refusal still clears protected rows and subscriptions before recovery.
- Source-reviewed: draft resume/cancel, edit-to-edit/reply/thread switching, internal/external focus transitions, Escape on textarea/Save/Cancel, hide/deactivate, pending success/failure after navigation, mobile selected-card conditions, ordinary pagination timeout versus authorization retry. Browser pointer/focus/mobile rendering and direct runtime assertions for these five flows remain unverified.
- Validation: npm run check passed with zero Svelte errors/warnings and tool type checks; npm run test:perf passed 7 files / 37 tests for existing saving/replay/cost, scheduling and cache guarantees. Targeted Prettier and affected-source git diff --check passed. No assertions weakened, tests added/expanded, browser checks, backend edits, deployments or commits.
- Evidence: /tmp/commenting-sibling-check.log, /tmp/commenting-sibling-perf.log, /tmp/commenting-sibling-format.log. This pass changed six frontend source files plus this progress note; start-of-pass snapshots distinguish these changes from the already dirty working tree.
