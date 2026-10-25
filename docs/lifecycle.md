# Saved contract navigation and saving

The contracts layout reads its own `ContractDestination` load data. Each keyed saved
view captures its ID for the whole mount, including teardown. Incoming Home data
cannot change the departing editor's identity. New-contract creation retains its
existing ID and coordinator until the saved view reports visible, with callbacks
scoped to the opening attempt.
Each opening, retry and reopening after interruption gets its own identity and
deadline covering rendering as well as data initialization. Creation registers its
completion callback before navigation can mount the saved view, and settles it once.
A stalled viewer offers Retry while retaining the created ID and editing session.

`WorkspaceScope` owns one membership-scoped `ContractSessions` registry above the
header and route bodies. A contract session owns its authenticated metadata
subscription, draft journal and `ContractPersistence`; views acquire explicit
attachment tokens. Ordinary navigation, including Home and Back/Forward, proceeds
without waiting for saving. Reopening attaches to the same pending session and
renders its latest local choices. Rendering readiness does not require an
acknowledgement; approval requests and Word export still require confirmed state.

Every selection checkpoints intent synchronously, then starts the existing
serialized, immutable operation protocol. Workspace feedback and Home card statuses
read that same owner. Errors and conflicts remain actionable after navigation;
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
reset an active view's local choices. Admin retains its explicit Save/Cancel owner.

Background writes require the live workspace. Refresh recovery uses the tab's
existing journal; tab closure does not guarantee network completion. URLs, backend
APIs and journal format are unchanged.

## Manual navigation checklist

- Open a saved contract, click Home once, and confirm both URL and content change.
- Change a selection and immediately click Home; reopen while saving and confirm
  the latest local choice appears. Verify the header and Home card agree on status.
- Use Back/Forward between Home and several contracts, including during saving.
- Create a contract; if opening fails, retry and confirm the same contract opens.
- Interrupt the connection while saving, leave, and confirm failure/recovery feedback
  remains available. Check the nonmodal save panel, Retry and conflict Open action.
- Check Admin Save/Cancel and a company-hold Settings detour with an open draft.

# Playbook authoring and persistence

`AdminWorkspace` owns one `AuthoringSession` and passes it the shared compiled contract, indexed geometry, and accepted records.
The session owns one active local draft, validation, reconciliation and persistence.
`AuthoringFlow` owns creation steps, staged concession additions, selected ranges,
selection feedback and the last locally added concession preview. Components bind
to draft content and own presentation state such as menus and focus. The Convex
transport is a separate adapter. Neither the app layout nor the rep workspace owns
an authoring session.

The membership-scoped workspace retains the mounted Admin owner through a temporary
company deletion hold and a Settings detour to cancel that hold. Its session, draft,
creation flow, and immutable unresolved operation survive; document preparation and
new reads pause, and the hidden editor cannot start another operation. Returning to
Admin restores the same owner. Ordinary departure still requires resolving an
operation or confirming abandonment. Membership loss, account switching, and actual
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

Outside clicks and Escape can dismiss a clean existing box. Dirty or unresolved
work stays open with inline feedback. New creation requires an explicit action.
Modal dialogs block underlying dismissal, and source picking includes the document
and selection toolbar in the interaction boundary. Internal navigation asks before
abandoning unsaved work and blocks while a save or delete is unresolved. Browser
unload only warns; local drafts are not durable across refresh.

## Operation outcomes and live reconciliation

Saving freezes editing and duplicate submissions. An acknowledged save or deletion
ends the workflow and closes the editor. The workspace restores the captured
annotation focus after the DOM updates and shows completion feedback for 2.5 seconds.
Operation errors and recovery actions remain beside the editor footer.

An uncertain transport outcome retains the exact frozen operation for Retry; there
is no new operation ID or queued replacement. A definite rejection leaves the draft
editable. Correcting its content permits a new save operation. A revision conflict
retains local work and offers Use saved version; it never silently overwrites or
merges another admin's edits. Missing records retain the local draft for explicit
cancellation. Editing and ordinary departure remain blocked until an uncertain
operation has a definite outcome. The company-hold Settings detour retains that
operation without retrying or abandoning it.

Clean drafts adopt newer live records. Dirty drafts become conflicted, and conflicts
track newer revisions and deletion. Updates received during an unresolved operation
are retained and reconciled after its result. An existing record's observed deletion
takes precedence over a conflict response. A creation conflict can arrive before
that record's first live-query appearance, so absence at that response alone is not
treated as deletion. Subsequent query updates reconcile it normally.

## Backend contract

`admin.savePlaybookItem` checks replays, missing records, and expected revisions
before content validation. It validates source-independent item content before
capturing the full playbook. Publication validates that capture, including source
references, Trigger uniqueness/overlap, change boundaries, concession rules, and
supported-size limits. Authoring, immutable revision creation, the full manifest,
and pointer advancement commit atomically. New items start at revision 1; accepted
updates advance the counter. Repeated operations acknowledge the existing result
without writing again.

Creation receipts map an operation UUID to a database ID atomically and outlive
items. Retrying creation cannot duplicate or resurrect a deleted item; replay after
another edit reports a conflict. Delete is explicit and confirmed, requires a
resolved editable existing box, checks its revision, and is idempotent when the
record is already absent. It does not queue behind another operation.

Semantic comparison preserves business text and structured references while
excluding persistence metadata. Creation mode is not part of the business payload.
Live records and immutable snapshots contain no creation-mode field. Deploy schema
and mutations with the frontend after clearing incompatible records and reseeding.

## Source selection and validation

Selection policy lives in `source-picking.ts`, with region-local geometry queries, structured issues and one
message formatter. Completed gestures are evaluated before showing actions or
accepting a secondary clause. Confirmed actions revalidate current source and items
before changing a draft. Initial eligibility checks source, Trigger and persisted
change invariants once, then checks concession-specific geometry separately.

The toolbar copies native start/end nodes and offsets alongside the accepted source
range. Changed endpoints invalidate actions; unchanged notifications, scroll and
resize preserve acceptance. Confirmation checks endpoints again before workflow
validation. Unsupported selection changes cannot confirm an earlier highlight.

Creation readiness combines session validation with a required secondary selection
on the other-part step. Complete session validation gates Save. Validation retains
original failures in a single-draft geometry memo and the validation result's
`diagnostic`, while `reason` contains safe
loading/size, translated geometry or generic fallback feedback. Revalidation clears
resolved feedback without changing transport or conflict outcomes.

## Contract concession reviews

Each required concession application has a lifecycle ID, saved atomically with the
selection. Changing, removing, or reapplying a choice creates a new application;
renaming the buyer or saving another choice preserves existing decisions. Required
choices applied by reps start pending; choices applied by admins start approved and
record the admin's decision. Legacy saved choices without metadata start pending.

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
all required reviews queues an immediate summary to the creator, with current
same-company reviewers CC'd. The final decision writes a small delivery event;
email preparation and immutable byte-bounded snapshots are separate from it.
Claiming dispatch checks that generation again. Current reviewer attribution is
maintained atomically in bounded records, while decision history remains an audit.
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
