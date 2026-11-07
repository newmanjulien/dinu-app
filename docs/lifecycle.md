# Saved contract navigation and saving

Current names and ownership are documented in [the data model](data-model.md).
Contract persistence uses one applications map, distinct local intent, and one
outstanding request. `savePending()` initiates contract saving. Account exits use
`prepareToLeave()`; authoring flushes only already submitted work and never submits an unsent draft.

The contracts layout reads its own `ContractDestination` load data. Each keyed saved
view captures its ID for the whole mount, including teardown. Incoming Home data
cannot change the departing editor's identity. New-contract creation retains its
existing ID and coordinator until the saved view reports visible, with callbacks
scoped to the opening attempt.
Each opening, retry and reopening after interruption gets its own identity and
deadline covering rendering as well as data initialization. Creation registers its
completion callback before navigation can mount the saved view, and settles it once.
A stalled viewer offers Retry while retaining the created ID and editing session.

`WorkspaceScope` owns one membership-scoped `ContractEditors` registry above the
header and route bodies. A contract session owns its authenticated metadata
subscription, draft journal and `ContractPersistence`; views acquire explicit
attachment tokens. Ordinary navigation, including Home and Back/Forward, proceeds
without waiting for saving. Reopening attaches to the same pending session and
renders its latest local choices. Rendering readiness does not require an
acknowledgement; approval requests and Word export still require confirmed state.

Every selection checkpoints intent synchronously, then starts the existing
serialized, immutable operation protocol. Workspace feedback and Home card statuses
read that same owner through membership-scoped `WorkspaceFeedback`. Its single
floating bubble host lives in the workspace shell, alongside document-local
rendering/selection feedback. Recent contract and authoring acknowledgements share
one 2.5-second expiry scheduler; Home retains contextual Saved badges. Live pending
work immediately suppresses stale success, with contract progress delayed 250ms
across a continuous burst. Contract errors, conflicts, holds and storage warnings
take precedence and remain actionable through Details, Open and eligible Retry.
Authoring progress and retained-draft notices come from the scope-owned session and
remain actionable after route teardown, including company-hold Settings detours.
Completion expiry continues while suppressed. Errors and conflicts remain actionable after navigation;
storage failures warn while intent is pending. The membership owns the unload
warning even when Home is visible.

Recovery reads each valid journal once before account-level pending state is registered,
and transfers that record and its storage status to the session.
It validates fresh metadata and loads the immutable template's approval requirements
before replaying any operation. Two recovered sessions initialize concurrently;
foreground opening is immediate and version reads use the existing shared cache.
Initialization has a 15-second deadline and failures remain pending until Retry or
explicit discard. Saving and recovery require no document viewer or document host.

The registry has one reactive map. Detached sessions release full template references
independently of save and flush lifetimes. Validated template identity and approval
requirements survive releasing rendering data; reattachment can reload the snapshot
without replacing a healthy subscription. A failure to reload rendering data reaches
the view's retry handling while saving continues. Unchanged readiness notifications
do no work. Detached sessions keep their subscription while saving, including through early live acknowledgement, until the write callback
settles. Clean sessions then dispose. Failed or conflicted detached sessions retain
compact editing state and the journal while stopping subscriptions. Recovery after
failure or connection replacement validates fresh metadata before resuming. Account
flushing pins sessions until its
result is captured so cleanup cannot turn a completed save into a failed exit.
Flushing considers only unresolved intent and submitted saves, so clean reads do not
delay an account exit. A clean initial read is canceled when its last view detaches.
Read failures reach the mounted view's existing retry handling. Sessions with read
failures and no unsaved intent dispose on departure and do not appear as failed saves.
Explicit discard does not report a successful save.

The account controller owns authentication readiness; company availability is a
separate gate, so account recovery cannot bypass a hold. Authentication interruptions,
company holds and transport replacement pause work.
Fresh reconciliation precedes replay; both account-exit saving phases may flush
while editing is frozen. Membership teardown unregisters the aggregate owner and
invalidates old callbacks. Every authoritative deletion uses the same idempotent cleanup:
intent, confirmed cache, opening records, document resources and recent save notices
are cleared. Deletion settles flush waiters successfully even if a submitted reply
is still outstanding. Renaming also updates recent save notices. Failed or
uncertain deletion rechecks live state before resuming. Already submitted backend
writes cannot be cancelled, so retries retain their operation identity. Interruption
settles account-flush waiters even when the outgoing write response never arrives.

Document resources retain rendering within their existing limits. Activation gives
each view an owned attachment for bindings, choices and cleanup. The incoming owner
is protected before releasing the outgoing attachment or applying retention limits. An outgoing view
cannot detach its replacement; acquisition and background cache updates do not
reset an active view's local choices.

`WorkspaceScope` also owns a lightweight `AdminAuthoringSession`, above both the header
and `/admin`. It creates its draft controller lazily and subscribes only while authoring
is attached or submitted/recovery work remains. Detachment releases source/viewer callbacks
and unsent local state while retaining the immutable submitted payload, operation UUID and
expected revision. Save closes a valid editor synchronously and publishes a dashed pending
annotation. A single outstanding operation/recovery slot permits navigation and unrelated
drafting, while another submission waits for reconciliation or explicit recovery resolution.

Authoring confirmation uses the backend's company-monotonic authoring watermark. Structure
and detail have separate acknowledgements: a successful complete structure snapshot confirms
membership/shape, and a successful detail snapshot confirms the revision/operation or a newer
authoritative state. An unchanged structural generation cannot acknowledge prose. Loading
and errors retain accepted content and the temporary confirmation bridge. Query refresh has
its own retry action; it never resubmits an already confirmed mutation. Older transport
callbacks cannot overwrite newer state or resurrect authoritative deletion.

Transport uncertainty retains the same UUID and immutable payload for Retry confirmation.
Definitive rejection/conflict retains the submitted draft for restore/discard through the
workspace notice and Admin. Conflicts retain the persisted target ID and a revision/watermark
floor, separately from the immutable retry request. Restore requires ready current structure
and detail agreement; stale/loading/error reads cannot establish deletion. A missing result
after a conflict must be newer than its witness, or agree with a newer certified baseline.
Restore creates a new editing attempt against the admissible current identity/revision; replacing a newer unsent draft requires an explicit choice. Restoring and
resubmitting uses a fresh operation and expected revision. Route leave checks apply to unsent
drafts only. The aggregate SessionEditor and unload warning cover submitted, uncertain,
recovery and attached unsent work; logout/company exit wait for submitted reconciliation,
while errors offer the existing retry/discard barriers. Account closing retains its unload
exemption. Explicit discard cannot undo a committed write.

Background writes require the live workspace. Contract refresh recovery uses its existing
tab journal. Admin recovery is retained in memory with unload protection; cross-reload/crash
recovery is not provided. Tab closure does not guarantee network completion.

## Manual navigation checklist

- Open a saved contract, click Home once, and confirm both URL and content change.
- Change a selection and immediately click Home; reopen while saving and confirm
  the latest local choice appears. Verify the floating bubble and Home card agree on status.
- Use Back/Forward between Home and several contracts, including during saving.
- Create a contract; if opening fails, retry and confirm the same contract opens.
- Interrupt the connection while saving, leave, and confirm failure/recovery feedback
  remains available. Check the nonmodal save panel, Retry and conflict Open action.
- Check Admin Save/Cancel and a company-hold Settings detour with an open draft.

# Playbook authoring and persistence

The membership-scoped `AdminAuthoringSession` owns submitted transport, confirmation
and recovery. It lazily creates an `AuthoringController` that attaches to `AdminWorkspace`
for unsent editing commands, document-action decisions and source validation.
Its `AuthoringContext` stores state and derives projections; it does not execute
commands or transport. Selection tokens express pending/opened requests; occurrence
coordinates and focus stay in the route's viewer. Detail snapshots and errors follow
logical selection/submission ownership, independently of temporary subscription release. Workflow variants distinguish editing, explanation creation,
concession creation and staged concession addition. Components receive read-only
drafts and call narrow controller commands. They own presentation state such as
menus and focus. The Convex transport remains a separate adapter. Neither the app
layout nor the rep workspace owns an authoring context.

Saved baselines, Triggers and accepted concessions are frozen and shared. Only
instructions and the isolated concession composer are mutable. Dirty state compares
visible instruction strings and ordered concession IDs. Restoring a visibly empty
field also restores its saved absent-versus-empty representation. Pristine creation
and staging remain protected independently of dirty state. The primary button and
its handler consume one derived action, label, disabled flag and validation reason.

The membership-scoped workspace retains the mounted Admin owner through a temporary
company deletion hold and a Settings detour to cancel that hold. Its controller, draft,
creation workflow, and immutable unresolved operation survive; document preparation and
new reads pause, and the hidden editor cannot start another operation. Returning to
Admin restores the same owner. Ordinary departure protects unsent drafts; submitted
operations continue in the membership session without delaying route departure. Membership loss, account switching, and actual
workspace teardown destroy the owner; refresh does not preserve local authoring work.

## Explicit transaction boundary

Save validates and submits one complete immutable instruction-box snapshot. No
input observer, timer, dismissal, visibility event or navigation sends a save.
Cancel discards the active draft without writing. New Explain and Negotiate boxes
both end with Save; their initial selection only determines the local draft shape.
Existing boxes always expose the same instruction fields and concession sections.
Concessions display read-only descriptions. Changing a concession requires deleting
it and adding a new one; unchanged structured replacement references stay intact.

Adding a concession to an existing box stages it separately. Next changes steps;
Back preserves the secondary selection and replacement. Turning off “affects another
part” explicitly removes that secondary change. The nested Add action validates and
copies the concession into the parent draft without writing, while nested Cancel
discards only that addition. The added concession becomes read-only in the parent
draft. Unrelated incomplete parent fields do not block Add;
the parent must pass complete validation before Save. There are no per-field saves.

Clicking another instruction box and starting authoring from selected text use the
same transition assessment. A clean existing box can be replaced; dirty work stays
open with a red warning. Moving among annotations in the same instruction box preserves
its context, and selecting a concession's secondary passage modifies that context.
Highlighting alone never opens or closes an editor. Selection detection remains enabled
with an open editor; a blocked authoring attempt preserves the native selection and
reports its restriction separately from source errors and operation status. Confirmation
revalidates the source and transition before replacing a clean context.

Outside clicks and Escape can dismiss a clean existing box. Dirty unsent work
stays open with inline feedback. New creation requires an explicit action.
Modal dialogs block underlying dismissal, and source picking includes the document
and selection toolbar in the interaction boundary. Internal navigation asks before
abandoning unsent work. An accepted save or delete continues through ordinary navigation.
Browser unload only warns; local drafts and submitted recovery are not durable across refresh.

## Operation outcomes and live reconciliation

Save validates a complete local command synchronously. Acceptance closes the editor,
restores its captured occurrence focus after the DOM tick and publishes pending annotation
state independently of the transport promise. The membership session retains one submitted
operation and publishes its eventual completion to shared workspace feedback. Another unsent
draft can open while that operation continues; another submission waits for the slot to clear.

Attempt and transport-generation identities guard result handling and cleanup. Restart
invalidates an old attempt while preserving the exact frozen operation. Late results cannot
close a replacement context, clear another attempt's running promise or revive discarded work.
Route-local entry and focus-intent guards protect focus restoration.

Uncertain transport outcomes retain the original UUID, payload and expected revision for
Retry. A definitive rejection, conflict or missing result retains the submitted body for
explicit restore/discard. A create replay can resolve the real persisted ID after another
admin edits it: the session learns that ID and conflict revision/watermark without changing
the original create request. Restore opens an admissible current version with the retained
intended body; resubmission captures a fresh UUID and expected revision. Replacing an unsent
draft requires an explicit choice. Discard cannot undo a write that committed.

Detail snapshots and errors belong to the attached selection and resolved submitted target.
Ending the last logical owner removes them immediately; retry, suspension and transport
release retain still-owned observations. A cold selection has a unique admission token and
pending/opened status. Only its matching request can open the editor. Authoritative missing
consumes the request and ends its loading state, preserving a prior editor only while that
editor remains valid. Its occurrence coordinates remain local to the viewer.

Clean drafts adopt newer live records. Protected local work retains conflict/deletion feedback.
Canceling an addition over a clean parent adopts the remote record; canceling over a dirty
parent retains conflict. Detail loading, errors and stale query absence never establish
removal. Restore requires ready structure/detail agreement, the learned revision floor and
baseline-sensitive watermark. Missing after a conflict must be observed strictly after the
conflict witness, or agree on a newer certified baseline. Current source/geometry validation
still applies to the restored attempt. Structure and detail acknowledge confirmation separately;
query Retry refreshes observations without resubmitting a confirmed operation.

Ordinary route departure protects unsent drafts while submitted work continues. Account exit,
company exit and unload retain their aggregate saving/recovery barrier. A temporary company-hold
Settings detour preserves the mounted owner while preparation and new reads pause. Membership
loss or workspace destruction ends in-memory ownership.

## Manual authoring acceptance checklist

`npm run verify` runs the existing lifecycle and performance assertions, type checks and
production build. These checks preserve the paths they exercise; they do not certify the
admin-session race schedules or native browser behavior below. No new tests or browser
automation are required by this implementation. Report actual check results separately.

- Open an unchanged box and switch clauses; edit a box and confirm a dirty switch retains
  the draft. Moving among annotations of the same dirty box preserves its context.
- Start new authoring and stage a concession, including a secondary change. Verify explicit
  Save/Cancel, nested Add/Cancel, Back and retained parent edits.
- Save the first instructions for a new clause. The editor closes and pending annotation
  appears immediately. Navigate away/reopen during saving and confirm the eventual body.
  Repeat while opening an unrelated unsent draft.
- Interrupt a create that commits. Unchanged retry can acknowledge saved replay; after an
  intervening edit it must return conflict for the real persisted clause. Restore must use
  admissible current identity/revision. Check subsequent deletion separately, including stale
  missing reads, and confirm replacement-draft permission is still required.
- Select a cold later occurrence by pointer or keyboard, then close the editor after hydration.
  Focus must return to that occurrence. Repeat with an existing clean editor, different
  fragments of the same annotation, a missing target and cancellation/navigation before detail.
- Tab/Shift+Tab to a distant untouched occurrence in a long document and through repeated
  source/generated fragments. Check Enter/Space, source/priority order, dirty geometry,
  repagination, boundary controls, headings, pending disabled state and existing selection.
- Cold native focus reveals the measured owner; programmatic close/post-commit focus preserves
  scroll. With fonts/commit delaying geometry, focus/semantics persist. Later paint must not
  steal focus or reveal after a newer keyboard, pointer, wheel or touch intent.
- Check query errors/refresh, account/company exit and unload protection, plus the temporary
  company-hold Settings detour. Ordinary departure confirms only unsent abandonment.

These browser and assistive-technology checks remain user-run acceptance. Existing automated
results do not measure perceived first-Save latency, CPU/frame time, heap or live Convex limits.

## Backend contract

`playbookItems.savePlaybookItem` checks authorization, replay, missing records and expected
content revisions before changed-body validation. Instruction-only saves read metadata and
one head/body. Geometry changes additionally validate against certified compact source facts
and heads, including trigger uniqueness/overlap, boundaries, references and ownership effects.
The head, changed revision body, receipt, ordered manifest, counters and pointer commit
atomically. Each writer packs its completed compact head once for storage and capacity
accounting. New items start at content revision 1; accepted updates advance it. Replays return
the existing result without writing again. The legacy `admin` adapter explicitly projects
its declared response shape; canonical clients also receive authoring watermark metadata.

Creation receipts map an operation UUID to a database ID atomically and outlive
items. Retrying creation cannot duplicate or resurrect a deleted item; replay after
another edit reports a conflict. Delete is explicit and confirmed, requires a
resolved editable existing box, checks its revision, and is idempotent when the
record is already absent. It does not queue behind another operation.

Semantic comparison preserves business text and structured references while
excluding persistence metadata. Creation mode is not part of the business payload.
Live records and immutable snapshots contain no creation-mode field.

## Source selection and validation

Selection policy lives in `source-picking.ts`, with region-local geometry queries, structured issues and one
message formatter. Completed gestures are evaluated before showing actions or
accepting a secondary clause. Confirmed actions revalidate current source and items
before changing a draft. Initial eligibility checks source, Trigger and persisted
change invariants once, then checks concession-specific geometry separately.

The complete `RenderSnapshot.selectionDocument` is the identity of a selection. Its immutable
positions use physical page/placement/token order and UTF-16 offsets, with distinct occurrences
for repeated table headers. Its break groups come from prepared composition and the existing
`flowRole` collapse classification, rather than baseline paragraph emptiness or page-local gap
inference. Construction cooperates with the renderer's existing preparation scheduler; metadata
does not enter geometric fingerprints, layout/profile inputs, or Word output.

`SelectionSurface` binds positions to exact mounted pages and prepared provenance. Ordinary
mouse drags use one page resolver at start, movement and final release, including left/right
page padding. Margins beside text choose a visual line and caret; margins beside a real gap
choose that shared break. Tables choose a row/cell before a line. Existing newline anchors supply
geometry for blank hard lines without contributing selectable glyphs. Page padding clamps to
real endpoints; continuations and page seams create no extra breaks.

The exclusive gesture owner waits for a cancelable, unconsumed `mousedown.detail === 1`;
pointerdown remains uncanceled. Missing or unclaimable matching mousedown cancels pending
authoring; an unresolved ordinary mouse hit cannot switch into native authoring. Multi-click,
word dragging, reserved pointer modifiers, keyboard, pen and touch deliberately remain native.
Native completion captures range, direction, session and surface identity together. Both input
paths use the same full-envelope validator; unknown leading, trailing or interior body text,
including whitespace, cannot be cropped away to obtain a source target.

Displayed extent and attachment are independent. Table, generated and revision content can
participate in either direction of a mouse drag and remain displayed/copyable when attachment
is unavailable. Text plus a terminal break is never clipped to fit persistence. A native envelope
that cannot be represented completely retains browser selection/copy with no attachment or
cropped override. Finalization and confirmation validate current contributions again.

Collapsed empty paragraphs retain their spacing and share the existing visible break. A new
pure-break attachment chooses its last eligible real alias; saved targets keep every exact key.
Only a normalized gap-only selection paints an insertion bar. A selection containing ordinary
text is one text attachment, even across paragraphs; traversed separators still participate in
physical selection and copy. Moving out of a gap into text clears its live bar. Text selections
do not acquire gap bookmarks, saved structural paint or insertion ownership.

Explicit boundary targets project their exact aliases into the current shared break for paint
and navigation. Legacy text targets can use gap navigation only when they relate to those exact
source separators or collapsed source ranges and every positive selected source-unit slice is
covered by the related groups' collapsed ranges. Whitespace counts as a positive slice; empty
points must belong to the collapsed source container and offsets. Numeric emptiness alone
never creates a navigation location. Visible source/replacement bounds take priority over this
fallback, which in turn takes priority over removed-source bounds. A selected invisible legacy
target can have a separate location marker without becoming a boundary attachment, even when
its collapsed whitespace still has a DOM range. Marker eligibility uses the same semantic helper
as saved navigation, independently of DOM range count.

Collapsed coverage starts from each empty output block's baseline source units and subtracts
exact source intervals displayed in every nonempty prepared paragraph, including generated
continuations and source-bearing redlines. Positive whitespace and atomic source lengths count;
source-less replacement/presentation tokens contribute no coverage. Genuine empty anchors and
deleted source with no surviving output token retain their group association. The cooperative
snapshot pass merges intervals by original source key and emits only uncovered source slices;
it changes no prepared fragments, spacing, occurrences or copy data.

Saved structural paint filters navigation memberships to explicit boundary targets. Coincident
menu entries retain their exact annotations and restore focus to the stable closed-menu trigger.
Zero-area groups retain saved navigation without a new pointer surface. Ordinary spanning text
does not join these menus merely because it crosses a gap.

The toolbar stores only a selection token and resolves a fresh candidate at confirmation.
Initial/secondary selection, workflow confirmation and target-only concession addition all
require the active complete displayed break context. Stale/missing context is unavailable;
there is no baseline-group fallback. Exact saved overlap/numbering semantics are unchanged.
Explain still requires substantive source text and Concession retains its geometry checks.

Attachment overlap and replacement effects use separate rules. A spanning explanation and an
insertion instruction between its paragraphs can coexist in either creation order. A text change
conservatively occupies every real source boundary strictly between its source endpoints, even
if the replacement recreates the same number of paragraphs. It conflicts with a boundary change
or Trigger at that exact source key. Ending at preceding text end or starting at following text
start only touches the boundary; selecting between those endpoints crosses it. Text cannot cross
the document-final boundary. A replacement generating extra paragraphs inside one source
container does not occupy its trailing insertion boundary. Synthetic display gaps and shared
visible aliases never define these source effects; distinct saved boundary keys remain distinct.

The same crossing predicate serves shared change conflicts and Trigger/change ownership.
Container-local indexed validation checks saved changes when a new boundary Trigger is proposed,
as well as saved Triggers when a text change is proposed. Within coarse container candidates,
only exact attachment intersection or a text change crossing a proposed boundary Trigger requires
full ownership revalidation against persisted Triggers and the entire proposed overlay. Disjoint
changes skip that lookup. Initial selection validates the Trigger
overlay first, then the prospective concession against saved Triggers. A crossing replacement
disables Concession while Explain remains available. Secondary selection checks the actual
primary change first and then validates both changes with the draft Trigger. The restriction on
authoring another explicit insertion into an instructed shared visible gap remains contextual.

Fresh structural template writes audit shared geometry, and current indexed editing checks
Trigger/change ownership. Active mixed changes use the shared conflict checker; composition
checks authored change/change conflicts before structural expansion, rather than auditing every
Trigger/change relation. Composition caches attachment-owner candidates by target kind for each
items identity, keeping all overlays and effect memberships. Thus an inactive boundary instruction
cannot prevent rendering a historical spanning text concession during annotation construction.
Strict authoring still checks all relevant kinds; same-kind partial crossings and ambiguous owners
retain their errors. Instructions-only versions carry prior audit proof. Saved-contract
replay/no-op, unchanged-choice and single-item paths retain their existing fast paths. Deployment
does not re-audit every immutable historical version; historical incidence remains unknown.
Historical invalid combinations keep their exact saved targets and existing editable diagnostics
and repair/exclusion behavior. No data migration or silent retargeting is performed.

The focused active document owns copy only for a current fully modeled extent. Plain text and
safe paragraph/table/revision HTML follow that same extent, retaining real whitespace and CR/LF,
joining continuation fragments and omitting page/control text and presentation placeholders.
A shared break emits one newline. Repeated table headers copy in physical encounter order,
including independent partial occurrences and traversed empty cells. Other fields and native-only
unmapped selections keep browser copy. A bounded keyboard bridge seeds directed real DOM
endpoints once before yielding to native commands; nonprojectable structural selections use
the nearest head-side endpoint. There is no editable mirror, fake source text or custom caret engine.

Controllers bind after the complete current commit and DOM tick, independently of toolbar
lifetime. Pending/progressive, parked and inert viewers cannot author with an old model. Escape,
capture loss, cancellation, blur, external ownership, source/model replacement and teardown stop
queued frames/autoscroll and invalidate actions. Geometry-only changes preserve positions and
refresh the existing visible/adjacent-page geometry, without a second measurement cache. Only
the exact owning toolbar is exempt from external focus clearing. The I-beam covers selectable
page padding and gaps; controls and chrome retain their own cursors.

Clearing an absent structural highlight group is a no-op, preserving valid hit geometry through
repeated text-selection updates. Clearing a real group still removes paint, prunes geometry and
schedules its update. Projection, content, affected pages, page replacement/removal, boundary
rebinding and destruction retain their independent invalidation paths.

The existing seven selection lifecycle assertions cover final native capture, Shift completion,
live-selection independence, unowned text/whitespace rejection and exact owned whitespace
offsets. The required performance suite checks the existing saving/scheduling/cache guarantees.
No tests or coverage were added. Browser acceptance remains necessary for margin/gap origins,
reversal, fast release, tables/repeated headers, saved aliases and focus, pure-gap shortcut and
context-menu copy, structured clipboard output, native keyboard, autoscroll, complex-script/bidi,
forced colors and pen/touch. Spacing, page count and Word appearance also require manual checks.
The existing automated suites do not prove gap-bar suppression, legacy collapsed-coverage
navigation or the full crossed/touched-boundary action matrix. These require user acceptance,
including explanation/insertion creation in both orders, later concession addition, secondary
changes, saved alias/legacy navigation, reversal and paragraph-preserving copy.

At the 2026-11-06 user checkpoint, the user confirmed side-margin drags into wrapped
text and paragraph gaps, reversal, gap-only copy, and reopening a saved gap annotation.
The browser/version and copy route were not supplied. This confirms those reported
cases, rather than the full browser matrix or both shortcut and context-menu copy.
Other platform/native-input, saved-target, lifecycle, long-document and Word appearance
checks above remain unverified.

Creation readiness combines validation with a required secondary selection on the
other-part step. Complete validation gates Save. Content/byte-size validation follows
the payload; reference validation follows concessions and compiled source; geometry
validation follows geometry version, Trigger/change shape and excluded item; capacity
follows item count. Instruction typing shares normalized frozen structure and does
not revalidate unchanged references or geometry. Staged Add validates its composer
once independently of parent content. The geometry memo retains original failures;
the context derives safe loading/size, translated geometry or fallback reason
strings. Revalidation does not erase transport outcomes.

## Contract concession reviews

Each required concession application has an `applicationId`, stored beside the concession in the
contract applications map. Changing, removing, or reapplying a choice creates a new application;
renaming the buyer or saving another choice preserves existing decisions. Required
choices applied by reps start pending; choices applied by admins start approved and
record the admin's decision. Stored-format conversion preserves existing application identities and decisions.

Current review state lives on the saved contract. Admin decisions validate company
access, the immutable template's approval requirement, and the current selection and
lifecycle. Decisions update only review metadata, without advancing the selection
revision or invalidating document rendering and Word preparation. Live subscriptions
carry decisions to both roles; same-revision save responses cannot replace a newer
live decision. Each decision also appends the admin's identity, previous and resulting
status, and timestamp to `concessionDecisions`. Scoped operation receipts make retries
idempotent even after another admin decides; distinct committed decisions use the
latest status. Automatic approval receipts and review receipts have separate namespaces.
Live confirmation retires an ambiguous client attempt, so a later override uses a
fresh operation rather than replaying its earlier receipt.

Review generation is separate from selection revision and advances for changed
saves and explicit changed decisions. Only an explicit decision that completes
all required reviews enters awaiting confirmation. Explicit completion confirmation
queues the summary to the creator, with the
triggering reviewer's current same-company address in CC. That authenticated
reviewer ID belongs to the delivery event, including retries. Email preparation
and immutable byte-bounded status snapshots are separate from it. Claiming dispatch
checks that generation and current recipient membership again. Current reviews
contain only concession, lifecycle and status; complete immutable decision receipts
retain historical admin identity. No separate current-attribution storage remains.
Delivery attempts, persistence retries, and recovery are shared with approval
requests and invitations. No batching timer is used.

Each applied concession owns one review state and one tab per affected part. Edits
owned by the same instruction trigger share a location; changes outside its triggers
are grouped by source container. This keeps an explicitly selected additional part
separate, including when it lies elsewhere in the same paragraph, and groups
concessions with several edits in one part. Each location anchors once at its first
visible edit, without repeating across page splits. All instances use the same
concession decision. Choices without text changes anchor once per instruction trigger.
Trimmed source text falls back to the nearest visible token in the same passage.
An unavailable anchor does not block navigation to the remaining reviews. Different
locations stack when they overlap.
Source parsing, text measurements, and location projections are cached per immutable
page. Sorted source intervals limit projection scans to matching tokens. Appending
pages only scans the new content; scale changes reuse page-local
coordinates. Status changes update labels without remeasuring text, and only the
open review menu is mounted.
Admins can change either decision using the same menu; reps see read-only status and
remove a rejected choice to clear it. Reviews are disabled until the current application
is saved. Word download requires every selected required concession to be approved.

An explicit approval request freezes the pending applications and reviewed context
into the existing recoverable email dispatch. Sending an email never changes review
status. Its `?review=1` link waits for current state and mounted pages, then focuses the
first pending concession's tab. A stale link reports that nothing is waiting and focuses the first
remaining tab or document. After a decision, navigation advances to the next pending
application in source order and wraps. Navigation consumes each request by identity,
including when a workspace reopens a retained viewer. The stale-link message clears
when another concession starts waiting. Decision history is retained without a UI and
removed in bounded batches when the contract is deleted.

Admin acceptance also needs first-instruction Save with unchanged pages/scroll/selection,
pending-to-confirmed identity, navigation during Saving, exact-operation retry after a lost
response, rejection/conflict draft recovery beside a newer unsent draft, query refresh errors,
logout/company exit and unload, keyboard focus/Enter/Space, screen-reader names, selection/drag,
repeated source occurrences, generated/removed text and structural gaps. Existing lifecycle
tests exercise the contract registry; they do not certify these new admin flows.
