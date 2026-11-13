# CSM setup and support calls

One Lifebuoy **support** widget appears for admins on the Contracts cards page,
Template and buyer-template pages, the new-contract page, and Integrations
(including detail pages). Reps have no support widget or booking access. Support
is hidden inside saved contract editors, on public buyer links, Settings, Manage
team, and contract settings. Admins can book support immediately, before uploading
a template or booking any earlier call. Ordinary help uses `support`; initial
required booking uses `setup` in the inline setup calendar. Exact-target
rescheduling opens the setup-replacement modal. A support booking never qualifies
as the required setup booking.

The support dialog host only mounts for admins. All client booking APIs, including
availability and receipt/status reads, require admin access. Queued sends recheck the admin role before creating a provider booking.
The instructional document Help walkthrough remains available to reps and buyers.

During setup, the launcher, Julien’s introduction, temporary embedded video, and
scheduling explanation differ by section. `supportSection` in `csm-support.ts`
maps every unreleased route requiring a template (`/template`, `/template/buyers`,
and `/contracts/new`) to upload help. After release, the template routes use
template help and `/contracts/new` retains contract help. Videos show an
app-controlled poster until Play is activated, then load a player with controls
and request playback. `csm-support.ts` owns this content and section resolution.
`WorkspaceShell` owns the single dialog host. Opening freezes its content; route
or role changes close it, while completing setup takes effect on the next opening.
Booking success keeps the confirmation, collapses the launcher, and restores focus
on close. Support can be booked again after an earlier attempt settles.

Setup uses one workspace-owned `accounts.setupHints` subscription shared with the
setup prompt. Both roles require a template, instructions, a contract they
created, and then a buyer link. The “Create link” action creates and copies a link
for the member’s latest own contract. Any buyer link created by the member, or an
existing link for their latest contract, satisfies the buyer-link step regardless
of where it was created or whether copying succeeded. Admins continue by installing
an integration and inviting colleagues. `accounts.completeSetup` authenticates the
membership and rechecks all facts before recording optional
`memberships.setupCompletedAt`. Completion is
sticky per membership across visits and devices; later deletions/disconnections
do not restart setup. Existing eligible memberships are detected on their next
workspace visit. Unknown or failed reads never count as completed. After completion,
the prompt disappears and admins see a plain support message and calendar across
supported sections, without a video.

Onboarding only navigates to the workspace. Initial setup renders Julien's
introduction and the setup calendar inline. Help starts collapsed, including when
browser storage is unavailable. Onboarding, upload completion, ordinary visits,
joining an existing company, and setup completion never auto-open the modal.

## Calendar and loading

`CsmBooking.svelte` renders a local Svelte month grid and daily times using the
app's typography, controls and tokens. Selecting a time reveals **Book** beside it.
Only Book submits; no attendee form or external booking fallback is presented.
The backend derives the attendee from the verified identity and stored profile,
using an email-derived nonempty name if the profile name is blank. Cal still owns
availability, calendar invitations, conferencing, and the cancellation/reschedule
links in invitations. The current event uses Google Meet, so the app says **video
call** rather than promising Zoom. Configure Zoom on the Cal event to change the
actual provider; the app never manufactures a meeting URL.

The picker supports IANA timezones, 12-hour display, DST offset labels for repeated
times, roving date focus, arrow/week/month/year keyboard navigation and unavailable
date context. Available dates are selectable with Enter/Space. Slots are ordinary
buttons, with Book next in tab order. The calendar reserves six rows, uses two
columns when space permits and stacks on smaller screens. The modal owns scrolling.

`WorkspaceShell` owns one in-memory availability resource for the live session,
transport, profile, membership and company. The widget still mounts after primary
content success or terminal-error paint on a supported section. Primary paint is recorded even before the widget is eligible. Modal code
imports share one promise; warming never mounts a hidden picker.

`csm-preload.svelte.ts` coordinates modal code, availability, the configured video
poster and optional video connection preparation. Each resource keeps its own
lifetime; readiness or failure of one never gates another. Explicit widget
preparation or an admitted modal opening requests warming. When that content has
a video, the host prepares its poster with high priority, independently of calendar
warming. The visible inline setup calendar reads through the same availability
resource under its current booking admission; it does not need a help interaction.

Calendar reads and modal preparation use these boundaries, after primary paint:

| Trigger                               | Policy                                                                                                                                                                                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Visible inline setup calendar         | Read the current setup mode/month/timezone through the shared resource when live receipt and booking admission permit it. Exact replacement reads wait for live appointment status.                                                                 |
| Explicit small→large widget expansion | Warm support before the focus continuation, without waiting.                                                                                                                                                                                        |
| Launcher hover or focus               | Warm support code and missing/expired times, and request a video connection hint when the current section has a video.                                                                                                                              |
| Modal opening                         | The admitted frame prepares code and the video connection and starts or joins the frozen mode/month/timezone read before the body or receipt loads. Mobile direct-open follows this path. Replacement reads still wait for live appointment status. |

Help has no unsolicited route or restored-state preload. A Map keyed by mode,
replacement purpose/appointment/UID, month and exact timezone retains pending requests and ready results (including
empty months) for two minutes after completion, with at most eight entries in
access order. Inline calendars, explicit preparation, opening, closing and same-owner
navigation share this resource; A → B → A reuses fresh/pending A. There is no
polling, persistence, adjacent-month preload or server cache. Expired, failed and
unavailable reads evict; Retry, submission, changed unresolved/failed receipts,
conflicts and booking success invalidate. Ordinary month/timezone changes retain
other entries. Elapsed starts are filtered on consumption without mutating cached
snapshots and checked again on submit.

Each visible waiter keeps its own deadline; cancellation does not cancel accepted
server work or stop it warming the same live owner's cache. Entry identity and
live ownership prevent late reinsertion after invalidation, eviction or replacement.
Unsafe session, deletion, lost eligibility, ownership replacement and shell teardown
dispose the resource. Closing and route changes release UI subscriptions/deadlines.

Expansion, launcher hover/focus and modal opening request one browser preconnect
hint to the privacy-enhanced YouTube origin when that content has a video. The
coordinator resets the hint on changed ownership or teardown. Preconnect is best
effort; it never mounts a hidden player or waits for a connection. The inline setup
calendar does not request support-video preparation.

Each configured video has an app-controlled `poster` URL alongside its ID and title
in `csm-support.ts`; the temporary local SVG can be replaced per section. The modal
immediately renders that image and a keyboard-accessible Play button at a fixed
16:9 size, independently of booking-code and calendar readiness. A detached `Image`
loads the poster early with high priority, using the same URL and browser cache as
the visible image without a preload hint's immediate-use expectation. Image loading or failure never
blocks Play or calendar work. Activating Play replaces the image with a
privacy-enhanced YouTube iframe, transfers focus to it and requests playback. No
player is mounted before activation. Closing the dialog, completing a booking,
navigation or changed ownership removes the player; reopening returns to the
poster. An already-open dialog keeps its frozen content when setup completes.
Completed-setup support has no video. Poster preparation resets on ownership changes
or teardown; provider connection warming remains best effort and independent.

Fresh times can appear immediately while the live receipt subscription is pending,
but date/month/timezone/slot/booking interaction requires a usable current receipt.
Receipt failure blocks booking with Retry; unresolved and success states take
precedence over the calendar. An owner-local advisory unresolved hint suppresses
speculative data reads after submitting or observing queued/submitting/unknown
work, including reopen. It never replaces the fresh receipt subscription: only an
accepted usable null/failed observation resumes reads; booked clears into success.
Ignored observations and status timeouts cannot clear it. The first unseen
unresolved receipt may still race one speculative read.

The two-minute/eight-entry policy is an initial bound, not a measured optimum.
Visible calendars and explicit help preparation may spend provider quota even if
the user never books. Starting work without awaiting it does not reserve quota;
achieved latency and real provider behavior require separate measurement.

## Setup-call bar

The existing viewer response supplies admin-only `company.setupCall`: a coherent
scheduled or cancelled fact with start/end, or null. The header uses this response
and existing route/session/company restrictions; it has no separate status
subscription or unknown-status bar. Confirmed facts survive failed refreshes,
pending successors and webhook hints. Scheduled reminders end at the confirmed
call end, including after sleep; accepted setup qualification survives. Cancellation
persists until confirmed rebooking or template release. Only cancellation offers
Reschedule, opening the existing exact-target setup calendar. Support never
qualifies as setup or changes the reminder. See [assisted setup](assisted-template-setup.md).

### Shared setup recovery and replacement

Initial setup and exact cancelled-appointment replacement use the same sanitized
`csmBookings:setupStatus` / `checkSetup` contract. Current eligible company admins
see ready/in-progress/uncertain/completed/unavailable. Only the original owner
receives a private attempt locator; colleagues receive no operation, attendee,
calendar fields, signed reference or receipt. A colleague can request GET-only
recovery using the original attempt's immutable attendee proof, including after
its creator loses membership. Support keeps private receipt recovery.

Read access to an exact same-company historical replacement can show completed
after its child becomes canonical. New creation still requires the exact current
cancelled source ID/UID, live admin/source ownership, unreleased template and no
uncertain reservation. No uncertain POST is retried. A cancelled Cal booking uses
one independent create POST after fresh source proof, configuration and
duration-aware slots; the clicking admin is the new attendee. No fabricated
provider successor link or reschedule flag is sent. The source proof fits the
45-second queued window and 43-second read deadline, with the 55-second watchdog
retained. Final claim rechecks ownership, generation, lease, source, scope,
evidence coverage and reservation. A provider change between GET and POST remains
possible; there is no cross-service atomicity or automatic cancellation.

Success atomically commits immutable creation confirmation, seeds the independent
appointment snapshot and permanently supersedes the predecessor. Retirement
invalidates late local proofs without cancelling invitations. The modal freezes
its target through async work, keeps confirmation until Close, and restores focus
to the original enabled control or launcher. Existing booking controls contain
recovery; there is no additional status row or modal.

## Provider and creation contract

`csmIdentity.ts` requires explicit positive numeric `CAL_EVENT_TYPE_ID` and
`CAL_ORGANIZER_ID`; setup and support intentionally share one event. Missing or
invalid creation configuration refuses new bookings without clearing confirmed
presentation. New authenticated reads match numeric event/host IDs. Mutable
organizer/type names are confined to the historical decoder.

The one current `book` mutation takes membership, mode, operation ID, original UTC
start, timezone and optional exact replacement. It acknowledges only
`{attemptId, operationId}`; only its live query writes UI receipt state. There is
no receipt negotiation, public context/link issuer or legacy settlement API.
Exact operation replay compares company/profile/membership context, mode, start,
timezone and replacement. Pending adoption is limited to the same mode/target;
an unrelated support/initial/replacement cannot become this calendar's success.
Client binding generations reject stale acknowledgements, queries and Check
continuations. Replaying the application mutation does not replay a provider POST.

Insertion freezes original ownership/attendee, numeric provider scope, opaque
`dispatchId` and exact versioned signed `attemptReference` before scheduling. New
metadata contains only `dinuCsmAttempt`. The reference binds deployment, purpose,
original time/timezone, ownership/attempt/dispatch and replacement/provider scope.
Appointment rows retain verified scope/reference independently of receipt survival.
Recovery compares persisted exact references; current keys never reinterpret them.

The sender retains fresh configuration plus explicit-duration slot GETs, a live
eligibility claim and one bounded create POST. Endpoint versions remain configuration
`2026-06-12`, slots `2024-09-04`, create/direct read `2026-02-25`, list `2026-05-01`.
Unsupported approval/payment/OTP/recurrence/seating/required fields/location refuse
creation; no bypasses or invented answers are sent. Recognized unambiguous enabled
booking windows bound navigation; other shapes retain the conservative bound.

Receipts remain queued/submitting/unknown/booked/failed. Accepted confirmation
`{uid,start,end,confirmedAt}` is immutable; later provider changes belong to the
appointment. Sender termination permits attendee-name erasure, and confirmed email
erasure; unresolved recovery keeps the original email until account/company
erasure. Current profile email is never substituted. Ambiguous acknowledgement,
transport failure, malformed POST response, 429 or timeout cannot authorize a
second POST or release uncertainty. There is no receipt TTL, timed unlock, slot
reservation or provider-wide exactly-once guarantee.

Only proven pre-dispatch/noncreating outcomes release admission. The narrow
`noncreatingRejection` mapper is tied to Cal's versioned error mapping, not generic
HTTP status or fuzzy matching; unrecognized errors remain uncertain. Its upstream
mapping does not prove every deployed error's creation timing. All real requests
share the 80/minute, capacity-12 limiter. Typed failures retain safe operation,
category, status, bounded request ID and retry delay, excluding raw bodies, URLs,
credentials, attendees and references. GET Retry-After delta/date values defer work;
malformed values use a bounded fallback. POST uncertainty remains independent.

## Durable evidence and appointment maintenance

The HMAC-verified HTTP webhook validates bounded supported events and commits
known work or durable `csmWebhookEvidence` before success acknowledgement. It does
no provider IO. Exact semantic duplicates preserve freshness, generation and
finite budgets; later event kinds, references, edges or occurrence/revision markers
remain distinct obligations. Ambiguous attribution stays retry/review. Every ninth
or conflicting locator remains durable outside the eight inline hints. A webhook
locator is an attribution obligation, never provider proof.

Unknown sender/watchdog outcomes atomically enroll GET-only recovery. Indexed due
work and leases repair interrupted workers. Original attendee creation proof stays
separate from established-UID appointment proof. Each pass remains bounded to three
100-record discovery pages and nine linked UID reads. Incomplete lists, empty
results, missing nodes, pending leaves and caps do not prove noncreation. Ten
unsuccessful evidence passes exhaust automatic recovery into private operator review;
quota deferral consumes no evidence failure budget. New authenticated evidence may
wake one bounded pass without resetting history. Routine focus/duplicates cannot
reset the horizon. Automatic negative settlement requires exact terminal sender
observation before every negative provider fact. Scoped late positives remain
possible; booked receipts stay immutable.

Routine appointment revisit skips fresh, backing-off, leased, reviewed, released
or permanently superseded work. Distinct authenticated evidence invalidates once;
forced replacement preflight remains fresh under its sender deadline. Expired
leases repair with generation fences. Normal and reviewed publication share
`applySetupProof`: original scope/reference, generation/evidence generation, current
UID, lease, coverage and provider-time/conflict fences. Failed refresh never
rewrites confirmed presentation. Cap, overflow or missing proof stops recurring
maintenance and retains review, rather than looping on impossible proof. Completed
evidence identities stay while a live target/review exists; unresolved obligations
never expire through TTL cleanup.

First template release schedules bounded local retirement, with relevance checks
again at enqueue/claim/commit/cron/notification. Existing released rows and late
work converge without deleting confirmed snapshots/history or cancelling provider
invitations. Creation outcome recovery continues independently of template UI
relevance. Account/company cleanup drains private work and prevents late
resurrection; reversible company deletion pauses preserve unresolved obligations.

Cold display still spends concurrent configuration and slots GETs. The browser
resource retains its existing two-minute/eight-entry coalescing and owner fences;
there is no shared persisted display cache. The concrete cost reduction is quiet
fresh/backoff/released/reviewed maintenance, duplicate coalescing and finite evidence
retries. Actual provider latency/quota behavior remains unmeasured here.

## Credentials and key rotation

Store these only on the matching Convex backend:

| Variable                                | Purpose                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `CAL_API_KEY`                           | Organizer-owned configuration/availability/create/recovery access.          |
| `CAL_EVENT_TYPE_ID`, `CAL_ORGANIZER_ID` | Explicit positive numeric IDs; one event for setup/support.                 |
| `CAL_METADATA_SIGNING_SECRET`           | New immutable booking-reference identity.                                   |
| `CAL_WEBHOOK_SECRET`                    | Raw-body delivery HMAC only; configure matching `/cal/webhook` destination. |
| `CAL_LEGACY_METADATA_SECRET`            | Preserved old delivery key, only for previously issued references.          |

Before rotating or losing the old delivery key, preserve it privately as the legacy
verifier on each authorized target. There is no fallback to today's delivery or
new metadata key. Rotating delivery signing cannot invalidate frozen references;
rotating metadata signing affects new attempts only. Verify actual numeric identity,
API scope and webhook destination separately; local code does not establish them.

## Historical rollout and operator review

The single bounded [normalization runbook](assisted-template-setup.md#snapshot-and-reference-reconciliation)
uses `csmMaintenance:normalize` dry-run/apply for attempts, appointments and companies.
It reports IDs/reasons, converted uncertainty and eligible/needed/added GET recovery.
Apply reuses live state/enrollment/retirement reducers and preserves lease, backoff,
review and budget. Missing original scope/reference/attendee proof remains guarded
review. `csmMaintenance:verifyIdentity` can freeze authenticated original historical
identity from a supplied UID; it performs GET only and cannot settle a receipt or
invent a dispatch identity.

`csmHistory.ts` alone reads old signatures, confirmation markers, single hints and
legacy locator graphs. `csmHistoricalAppointments:discoverLegacy` inventories one
provider page of all statuses; `importLegacy` proves a bounded original chain.
Source-unbound company links require independently reviewed original-profile
association (`reviewedProfileId`, bounded `sourceEvidence`), never email matching.
Previously issued links can still create future external obligations. Keep their
verifier until actual inventory/retirement accounts for them.

See [review procedures](assisted-template-setup.md#reviewed-recovery) for private
creation, erased initial guards and exhaustive appointment review. Missing proof
remains closed; no timer or boolean-clear escape hatch exists. Positive erased
dispatch discovery retains its company guard without reconstructing personal data.

No deployment, environment change, live inventory/apply, provider operation,
operator disposition or browser verification is part of local implementation.
Release matching backend/client code and retire old tabs. Keep additive legacy
schema/readers until inventories are empty or every unresolved obligation is safely
retained/converted, old scheduled invocations are drained, and issued links are
accounted for. `csmBookings:recoverWebhook` and
`csmSetupAppointments:legacyWebhook` remain only to drain old scheduled names into
the durable inbox; remove them after proving that drain. Old context, settlement,
receipt-maintenance and snapshot/reference converter APIs have been removed; do
not invoke them. Do not narrow schema or delete verifiers on an assumed empty DB.

Local required checks cover existing perf assertions, backend/app/tools types,
production build and loading boundaries. New inbox, enrollment, review, erasure
and release transitions are source-reviewed under the no-new-tests constraint.
Deployed scheduler behavior, SaaS error timing/metadata visibility/races, historical
data, live key rotation, reviewed investigations and browser behavior remain
separate rollout/manual checks.
