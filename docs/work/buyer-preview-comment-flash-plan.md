# Buyer preview comment flash: implementation plan

## Why this work exists

The seller's **View as buyer** toggle briefly removes existing comments and moves the document before the comments return. The earlier “Investigate comment flash” conversation observed the comments disappearing at about 3.27 seconds and returning at about 3.33 seconds. The intended result is a buyer preview that keeps the document and comments steady, shows buyer-facing attribution, and provides no seller writing controls. Comments already on screen may animate into the buyer presentation once that presentation is ready; reduced-motion preferences must be respected.

This plan was reconstructed from that conversation and a read-only review of the current code on 2026-11-25. The codebase has changed substantially since the earlier investigation, especially discussion pagination, buyer-link loading, and session ownership. The earlier temporary plan is unavailable, so this document describes the current implementation path rather than assuming its proposed code still applies. The working tree already contains extensive unrelated and related edits; preserve them during implementation.

## Starting behavior and cause (before Phase 1)

- [`BuyerDiscussions.svelte`](../../src/lib/buyer/BuyerDiscussions.svelte) constructs a `DiscussionSession` in an effect that depends on `seller.visible` and `seller.preview`. Toggling preview changes those dependencies. The effect destroys the old session, reports `onSession(undefined)`, and creates a new session with a different client and write policy.
- [`session.svelte.ts`](../../src/lib/discussions/session.svelte.ts) currently owns both the link's read feed (thread pagination, reply streams, authorization) and actor-specific work (viewer identity, drafts, auth preparation, writes). Destroying it clears the feed. `PaginatedFeed.start()` also clears its pages before the next subscription result arrives.
- [`DocumentViewer.svelte`](../../src/lib/components/document/DocumentViewer.svelte) reserves the right rail when the current session reports visible comments or an active composer. While the replacement session has no rows, the rail disappears and the paper recenters. The buyer document host itself does not need to remount for this flash to occur.
- [`seller.svelte.ts`](../../src/lib/buyer/seller.svelte.ts) already has a preview generation in `discussionPolicy`, but the current `BuyerDiscussions` path does not consume it. The session's `captureWriteAccess()` checks activity and read-only state but does not fence a write across a complete preview-to-seller round trip.
- Discussion list and reply reads are scoped to the buyer link, including for authenticated sellers. Seller authentication is needed for seller actor queries and mutations, not for a separate copy of the comment feed. [`MessageByline.svelte`](../../src/lib/discussions/MessageByline.svelte) already supports buyer-facing versus seller-facing attribution.

## Target state

One buyer-link-scoped read state owns the live thread and reply subscriptions, pagination, and authorization for the life of that link's document view. Perspective changes do not recreate or restart it. A separate actor state controls whether the current user is a buyer, an authenticated seller, or a seller viewing a read-only buyer preview. The actor state owns identity, drafts, recovery, and write transport. Switching perspective updates the actor and presentation in place while retaining the read state and document geometry.

The read state is discarded when the actual link/document identity changes, the document view ends, or access is lost. A real access failure must clear protected rows; retaining stale comments through a failed authorization is not part of the transition behavior.

## Phases

These are short checkpoints, not separate releases. Finish the implementation and integrated review through Phase 5 before running any further automated tests or builds. Phase 6 is dedicated to those checks. Phase 1 checks ran before this testing schedule was set and are recorded below.

### Phase 1 — Separate reads from actors (done)

- Give the buyer link's threads, replies, pagination, and authorization one read owner that survives perspective changes. Keep link reads on the public buyer-link client.
- Keep identity, drafts, auth preparation, and writes actor-owned. Change actors in the retained session without restarting reads; hide transient controls and preserve seller drafts privately for return.

**Checkpoint:** Read lifetime follows the link/document, while actor capabilities follow the current perspective.

### Phase 2 — Fence actor transitions (done)

- Audit asynchronous viewer loads, auth preparation, delayed actions, and writes. Capture actor identity and generation; recheck before dispatch and before applying actor-specific completion state. A queued seller action must not dispatch after a perspective change, including a round trip back to seller view.
- Ensure preview hides writing and actor-auth recovery controls, blocks writes at the session boundary, disables seen-message writes, and shows buyer-facing bylines. Returning to seller view restores seller capabilities and attribution; an actual buyer retains buyer capabilities.

**Checkpoint:** Old actor work cannot write or restore stale UI in a later perspective. Already-dispatched writes may settle through the retained feed.

### Phase 3 — Keep the rail and anchors steady (done)

- Reserve the rail from retained read state through a perspective change. Distinguish pending reads from confirmed empty discussions, and clear protected rows on real access loss.
- Keep the document host, comment anchors, expanded replies, and loaded pages in place while presentation changes.

**Checkpoint:** Repeated toggles neither empty the visible rail nor move the paper; genuine empty and unavailable states still settle correctly.

### Phase 4 — Add preview entry motion (done)

- Reveal existing comments only when their buyer-facing presentation is ready. Repeat the entry motion on each seller-to-preview switch without remounting the feed or animating paper position.
- Follow the app's existing motion style, respect reduced motion, and put static UI styles in inline Tailwind classes.

**Checkpoint:** Preview entry has a ready-state reveal with no empty interval, document shift, or motion when reduced motion is requested.

### Phase 5 — Review and finish the implementation (done)

- Review the scoped diff against the checkpoints: repeated toggles, pending versus empty or revoked reads, stable replies and pages, draft recovery, stale write fences, attribution, and read-only preview. Resolve any implementation gaps found in that review while preserving the existing dirty working tree.
- On authorization failure, clear retained actor drafts and recovery state as well as protected comment rows; an edit draft can contain text from a message that is no longer accessible.
- Finish the code and plan updates before starting automated checks. Leave browser behavior for the user to check unless a specific unresolved issue makes our browser check absolutely necessary.

**Checkpoint:** The implementation is ready for one final automated verification pass, with remaining manual UI checks identified.

### Phase 6 — Run tests and build (done)

- Run `npm run test:perf` for the required caching/lifetime guarantee and `npm run build` for Svelte checks and production compilation. Use other existing tests only if a concrete unresolved risk makes them absolutely necessary. Do not add or expand tests without an explicit request.
- Fix any failures without weakening existing guarantees, then report which automated guarantees passed and what remains unverified.

**Checkpoint:** Required checks pass, and the remaining manual UI checks are clearly stated.

### Phase 7 — Resolve the post-implementation review findings (done)

- Preserve a composer submitted during an actor transition as an actor-private draft. Keep its text and operation identity fixed until a retry confirms the result or a definite rejection releases the draft for editing.
- Clear the delete-in-progress lock when the session becomes inactive, so a temporary document error cannot block later deletes after recovery.

**Checkpoint:** Preview round trips retain pending text without allowing an uncertain write to be submitted again under a new operation identity; temporary deactivation releases the delete lock.

### Phase 8 — Verify the follow-up fixes (done)

- Run the required performance suite for saving changes and a compile/type check. Use existing targeted tests only if a specific risk remains unresolved. Do not add new tests or run browser automation.
- Record the checked guarantees and any manual UI behavior that still needs verification.

**Checkpoint:** Follow-up checks pass and remaining manual checks are documented.

## Progress as of 2026-11-25

Phase 1 is implemented. [`read-state.svelte.ts`](../../src/lib/discussions/read-state.svelte.ts) now owns buyer-link thread and reply subscriptions, pagination, and access state through the public client. The retained `DiscussionSession` changes buyer, seller, and preview actors in place; seller identity and writes continue through the authenticated seller client. Mode changes hide editors, selections, menus, and delete confirmation while keeping idle drafts private to their actor for return.

`npm run build`, `npm run test:perf` (38 tests), and the existing buyer discussion and access recovery checks passed during Phase 1, before the testing schedule above was set. No browser check was run. Further automated checks were then deferred until Phase 6.

Phase 2 is implemented. The session now checks captured actor identity, client, activity generation, and preview policy generation before writes dispatch or actor-specific completions apply. The existing viewer load and account preparation paths use that same captured access check. Seen-message observers and batches also capture the current actor and preview generation, so queued acknowledgments cannot dispatch after a preview round trip. Read-only preview continues to hide editors and actor-auth recovery controls, and composer text changes are rejected at the session boundary while read-only. Buyer and seller bylines follow the current perspective. Delayed focus restoration and rail scroll actions are fenced against a perspective change.

Only a scoped code review and `git diff --check` were performed for Phase 2. No tests or builds were run.

Phase 3 is implemented. The retained read state now exposes when its first page is pending, and the document reserves the comment rail in that state. A confirmed empty result releases the rail; a failed first-page read clears protected rows and stale account recovery UI. The create composer stays hidden without authorized reads. Actor transitions preserve the visible thread selection while keeping each actor's draft private, so the same comment card, reply stream, loaded pages, and document anchors remain mounted across perspective changes.

Phase 3 received a scoped code review and `git diff --check`. No tests, builds, or browser checks were run.

Phase 4 is implemented. Authorized comment cards gain a short fade and 3px lift when the seller switches into buyer preview. The animation class follows the same reactive policy and perspective that render buyer-facing bylines, so the entry starts with that presentation. Returning to seller view removes the class and allows it to run again on the next preview switch. The animation stays on the existing cards and does not affect the rail or paper geometry. Its starting opacity keeps comments visible throughout, and `motion-safe` disables it for reduced-motion preferences.

Phase 4 received a scoped code review and `git diff --check`. No tests, builds, or browser checks were run.

Phase 5 reviewed repeated actor and preview transitions, first-page pending/empty/error states, reply leases and pagination lifetime, idle draft restoration, write and seen-message fences, buyer-facing attribution, and read-only controls. The review found that authorization failure cleared visible content but left private actor drafts and recovery flags in memory. The deauthorization path now clears them too, including edit drafts that may contain text from a protected message. The read feed and its reply streams remain mounted for ordinary preview toggles; a genuine first-page failure still clears protected rows.

Scoped code and whitespace review completed. No tests, builds, or browser checks were run during Phase 5. Manual UI checks after Phase 6: repeated seller/preview toggles with comments and expanded replies, an idle seller draft restored on return, a confirmed empty discussion, access recovery after a read failure, buyer-facing bylines and missing write controls in preview, and reduced-motion behavior.

Phase 6 is complete. `npm run test:perf` passed all 38 tests across 7 files. `npm run build` passed, including Svelte checks with 0 errors and 0 warnings, tool type checks, and client/server production compilation. The existing targeted component check, `clears discussions on delivered access rejection and recovers on retry`, passed. These checks cover the performance suite, compile and type validity, and visible row clearing/recovery after a delivered access rejection. They do not exercise preview toggle visuals, reduced-motion behavior, or the private actor-draft cleanup on access loss; the latter was verified by the Phase 5 code review, and the UI cases remain for manual checking. No new tests or browser checks were run.

Phase 7 resolves three issues found in the later read-only review. Actor transitions now keep a pending composer instead of dropping it. After an uncertain result, the composer keeps the submitted text and operation ID, disables editing and cancellation, and offers an idempotent retry; a definite rejection unlocks editing with a fresh operation ID. This applies to create, reply, and edit. The session also clears its delete lock on deactivation, while old delete completions remain fenced by the activity generation. Scoped whitespace review passed.

Phase 8 passed `npm run test:perf` (38 tests across 7 files) and `npm run check` (Svelte checks with 0 errors and 0 warnings, plus tool type checks). These checks cover the required saving performance guarantees and compilation; they do not exercise an in-flight preview toggle, an uncertain write retry, or the temporary deactivation delete path. Those state transitions were reviewed in code and remain for manual UI verification alongside the visual checks listed above. No new tests or browser checks were run.
