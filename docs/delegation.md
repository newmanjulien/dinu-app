# CSM setup and support calls

Before a company books its setup call, **Delegate setup** appears only on `/admin`
for admins with an active template. After booking, **Get support** appears on every
workspace route for all members. `WorkspaceShell` owns one shared modal host for both launchers and the setup-call
bar. It opens `CsmBookingModal.svelte`, retaining the
mode-specific title, Julien's introduction, the app's success message and manual
Close. Completion collapses the launcher; closing restores focus to its icon.
Support can be booked again after an earlier attempt settles, even when another
call is still upcoming. Cancellation never restores setup mode.

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
content success or terminal-error paint and requires an active template in setup
mode. Primary paint is recorded even before the widget is eligible. Modal code
imports share one promise; warming never mounts a hidden picker.

Actual times and modal code preload at these boundaries, after primary paint:

| Trigger                               | Policy                                                                                                                                                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/admin` setup visit                  | Automatically once per continuous eligible visit for a safe prepared admin with `manageTemplate`, including before the first template upload. Failure, paint revisions and TTL expiry do not create a retry loop. Leaving and returning permits another attempt. |
| Valid authenticated contract upload   | On `/admin` and `/contracts/new`, dispatch the upload POST first and then warm missing/expired times. One upload-refresh attempt per owner across file retries.                                                                                                  |
| Valid Continue                        | Warm missing/expired times alongside commit and navigation. Calendar work is never awaited and cannot fail the upload/commit.                                                                                                                                    |
| Explicit small→large widget expansion | Warm both setup and support before the focus continuation, without waiting. Restored expansion and onboarding card expansion are not this trigger.                                                                                                               |
| Modal opening                         | Import code immediately; the admitted frame starts or joins the frozen mode/month/timezone read before the body or receipt loads. Mobile direct-open follows this path.                                                                                          |

Support has no unsolicited route or restored-state preload. A Map keyed by mode,
replacement purpose/appointment/UID, month and exact timezone retains pending requests and ready results (including
empty months) for two minutes after completion, with at most eight entries in
access order. Upload, Continue, expansion, opening, closing and same-owner
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
Abandoned uploads and automatic setup visits may spend provider quota. Starting
work without awaiting it does not reserve quota or guarantee upload network/CPU
priority; achieved latency and real provider behavior require separate measurement.

## Setup-call bar

`CsmSetupCallBar.svelte` appears beneath navigation on every workspace route for
**company admins only**, independently of the Delegate/Support launcher. It subscribes
after the primary surface paints and clears with company/profile/session/transport
changes, closing or deletion. Support bookings never create or select a bar.

The bar shows the verified setup time in the viewer's browser IANA timezone,
showing weekday, month, day and time, without year or timezone text. The blue
InfoBar treatment, compact padding and all-regular-weight text are shared across states. It selects the earliest non-ended
setup call, then the most recently cancelled chain, then an unresolved setup chain.
Anchor UID breaks equal-time ties deterministically. It stays through an in-progress
call and disappears at its scheduled end, without asserting attendance. A cancellation
notice stays until a verified provider successor or successful app replacement
supersedes it (subject to the same selection policy). Only cancellations show
**Reschedule**, which opens the existing calendar in setup-replacement mode on any
workspace route. The launcher stays in Support mode.
Stale/unresolved status says that details are being checked and never presents an
old time as current. Verified cancellations can remain visible without a current time.

### Cancelled-call replacement

A cancelled Cal booking cannot use Cal's reschedule endpoint. The app verifies its
current authenticated chain and uses ordinary slots plus one independent create
POST. It does not send `bookingUidToReschedule` or manufacture Cal successor links.
The clicking admin is the new attendee, derived from their verified identity/profile;
the original appointment and creation receipt retain their original attribution.
All current company admins see sanitized shared progress; another admin's operation,
receipt, attendee or timezone is never exposed. Support calls never qualify.

A creation attempt freezes its predecessor appointment ID and current UID. The
predecessor's latest-attempt pointer coordinates admins/tabs transactionally, without
a company-wide booking limit. Queued/submitting/unknown work, missing receipts and
failures without authoritative noncreation evidence block a second replacement.
Exact replay checks the frozen operation fields; an unrelated owned pending booking
cannot be adopted as replacement success. Shared recovery uses the same bounded
receipt reconciliation and per-source/provider quota. No uncertain POST is retried.
Proof cleanup releases only the exact lease token acquired by that sender, even if
a safe retry has since advanced the latest-attempt pointer. A later claim increments
the token and cannot be released by an earlier sender. Admission still requires the
canonical pointer and every existing source/ownership fence.

Source proof, event configuration and fresh duration-aware slots fit within the
45-second queued claim deadline, reserving 12 seconds before each bounded GET and
a final claim before expiry; no long snapshot-quota wait is inherited. The existing
55-second watchdog remains. Final transactional claim applies the same scoped chain
proof/revision/lease/generation/pending checks as refresh and rechecks current admin,
company, source profile, baseline, target and reservation. A real provider successor
updates the source and stops new creation. Cal edits between that GET and the
independent POST remain possible: there is no cross-service atomicity or automatic
cancellation of either booking.

Success atomically settles the immutable receipt, seeds its independent setup
snapshot, and retires the predecessor with `selection: 'superseded'`. The shared
retirement transition clears pending local jobs, repair/freshness deadlines and the
lease, invalidating captured proof without cancelling already running reads. Every
maintenance writer preserves that terminal state, including after the child ends,
is cancelled, is replaced again or is erased. Its last authenticated provider facts
and identity remain historical; bounded unresolved locators and sticky overflow
are retained without claiming fresh proof. Replacement-aware legacy rows do not merge away reserved IDs. Before a
clicking admin's private receipt is erased, cleanup preserves successful suppression,
releases proven noncreation, or leaves an anonymous uncertain block. Original-source
deletion prevents a queued claim; a dispatched independent booking may still settle
under its own owner's live-company/profile rules. Local cleanup never cancels Cal
invitations. A stale sender cannot claim or recreate erased data.

The shared modal freezes its target across async work and subscribes to that source
independently of company banner selection. Replacement cache entries include purpose,
source ID/UID, month and timezone, with the same two-minute/eight-entry/coalescing
policy. Replacement reads start only after shared source status admits them. Source
changes stop selection; owned pending/unknown receipt recovery and confirmation can
continue. Confirmation stays open until Close, restoring focus to the original
visible enabled button or the CSM launcher after successful replacement removes it.

Rollout is separate: deploy the additive selection union and all admission,
retirement, maintenance, event and cleanup writers together before enabling the UI.
Existing permanent predecessors require the bounded normalization described below
unless their absence is positively established on the authorized target. A UI rollback
must retain these backend safeguards and support for `superseded` once data exists;
do not clear the latch, narrow the schema or rearm historical sources.

`csmSetupAppointments` stores one small mutable snapshot per proven setup chain,
separately from the immutable creation receipt and permanent Support promotion.
It retains original company/source-profile attribution, anchor/current UID, current
facts and bounded sync/job controls; no attendee copies, payloads, meeting links,
cancellation reasons or booking-history graph. Account deletion drains source rows
and cancels jobs before an owner-recovery pause. Company cleanup also drains them,
including a final fallback for cleanup workers already beyond the CSM phase.
Reversible company deletion preparation/dispatch instead retains snapshots and their
original attribution, pending locators and repair obligations. It blocks new admission
and refresh claims, clears freshness/leases and defers ordinary repair by a minute when observed.
Permanently superseded rows remain retired through a pause and never acquire that deadline.
Cancelling preparation or its TTL expiry resumes ordinary repair with the retained row
still dirty. Missing/tombstoned source profiles, missing companies and actual company
cleanup erase snapshots. Every seed/commit/deadline rechecks ownership; local cleanup
does not cancel Cal invitations.

Signed webhooks durably invalidate ordinary snapshots; authenticated Cal reads verify current
state and explicit successor/predecessor links, with nine unique UID reads per pass.
One-sided authenticated links may join records, but every present reciprocal field
must agree. A shared cache proves all current/pending roots form one nonbranching
chain with one complete forward leaf; delayed ancestor hints cannot roll it back.
Legacy admission also proves the visible predecessor anchor. Compatible legacy
snapshots converge only when that proof covers every affected current locator and
pending obligation; the oldest snapshot retains its frozen source and anchor. Replacement-aware rows
fail conflicting convergence closed, preserving reservation IDs and immutable bindings.
Native/legacy, different original sources and unproved chains never merge.
Events associated with a known permanently superseded predecessor retain bounded
successor hints and mark unresolved evidence dirty, without refreshing or adopting it
again. The selected native-recovery or legacy route acknowledges that known event
before further discovery. The independent child's events and receipts keep their
own recovery path. A webhook hint alone never authenticates current provider facts.

Invalidations atomically union up to eight distinct pending successor UIDs. Existing
single-hint rows are read compatibly and canonicalized during ordinary transactions.
A ninth distinct locator latches overflow while retaining the eight: subset reads,
imports, expiry and ordinary repair cannot clear it or publish clean facts. Overflow
may remain unresolved indefinitely; an authoritative reset is a separately scoped
operation. Invalid incoming hints cannot admit a row or replace its obligations.
Only complete same-generation success discharges all pending locators. Generation,
lease/current-UID and current ownership fences reject outdated results. Cycles,
contradictory scope/links, caps and provider failure retain checking/repair state.

Trusted current-state start/end/updatedAt require real Gregorian instants with seconds,
an uppercase `Z` or numeric offset and at most three fractional digits. Ambiguous or
impossible dates fail closed; valid offsets normalize to UTC. This does not change
the original attendee-scoped creation/receipt date parser.

An already claimed refresh may continue bounded GETs through preparation or quota
waits; there is no per-read ownership query or promise of zero later dispatches.
Commit rejects or defers results if ownership is paused/erased or its normal fences changed.
Permanent supersession takes precedence over every proof result and cannot regain
freshness, facts or maintenance work through a late commit.
An observed pause invalidates the old claim even after cancellation. A pause that
begins and ends entirely between ownership observations has no historical revocation
marker; active ownership and unchanged fences govern its eventual commit.

Provider-independent scheduled mutations expire display freshness and hide a call
at its end, allowing the next candidate to be selected even if Cal is unavailable.
Browser deadline/wake handling provides a local fallback. An indexed cron admits
five due rows per minute; active/checking repair targets 15 minutes and cancellations
a day, with bounded backoff/jitter and the shared 80/minute provider budget.
Claimed refreshes retain their cache/cursor through local quota denials, waiting only
within the three-minute lease, with a 15-second reserve and room for the 12-second GET
timeout. Local deferral retains every obligation and a finite retry time without
increasing provider-failure backoff. Pre-claim imports and foreground calls still fail
immediately on local denial; dispatched failures and POSTs are never auto-retried.
Failed final reads retain repair obligations even while ordinarily hidden. For those chains, normal polling
stops only after a successful read of an accepted past leaf with no pending obligation
or overflow;
a later missed post-terminal webhook may remain unknown until a cooldown-limited
admin revisit (which refreshes the latest ordinary hidden chain). Permanently
superseded predecessors occupy a separate indexed selection and receive no recurring
repair, refresh claims or expiry jobs. These are cadence targets,
not delivery/latency guarantees. Deleting a personal-calendar invite is reflected
only when Cal records a change.

The header retains a fixed `--app-nav-height` and measures its total height into
`--app-header-height`; document offsets/rail/sticky panels consume the total.
The existing highlight ResizeObserver also observes the header and calls
`projectionChanged`, notifying selection geometry when the bar wraps or disappears.

### Initialization and legacy coverage

Backend deployment and initialization are separate rollout steps on an explicitly
identified target. After the additive backend is present, invoke private
`csmBookings:maintainReceipts` page by page, then
`csmSetupAppointments:initialize` with `{ cursor: null }` and each returned cursor.
Each page is bounded to 25 receipts. Both first-confirmation paths use the same
idempotent seed helper; blocked booked-without-confirmation rows stay unresolved.
Repeat full passes until seed/change counts converge, then inspect snapshot repair
outcomes before enabling the client. An existing promotion timestamp alone never
supplies a meeting date.

Permanent replacement retirement has its own one-time maintenance. On an explicitly
authorized target, deploy all terminal-aware backend changes as one version first.
Read private `csmSetupAppointments:normalizationInventory` from `{ cursor: null }`
through each returned cursor until `isDone`, summing page-local `superseded` and
`remaining` counts. Each page examines at most 25 appointments and returns no
identities or provider locators. If any historical predecessors exist or their absence
has not been established, invoke private `csmSetupAppointments:normalizeSuperseded`
the same way, recording cursors and scanned/normalized counts. It traverses snapshots
directly, including predecessors whose private receipt was erased, retires surviving
latched rows and removes erased owners under the existing cleanup rules. `normalized`
counts actual retirement changes; owner erasures are outside that count. Repeat pages
are safe and no permanent scan cron is installed.

After maintenance, run a complete read-only `normalizationInventory` traversal and
require the summed `remaining` count to be zero. This verifies the stored terminal
projection and maintenance fields, including compatible legacy-hint normalization;
it does not prove no already dispatched GET remains or certify scheduler/webhook
delivery. Retain bounded unresolved evidence, historical associations and independent
child chains. Release the compatible frontend after backend readiness; if already
enabled, it can remain enabled during the compatible backend update. Keep receipt
initialization and reviewed legacy imports separate from this pass. Local implementation
does not execute deployment or stored-record normalization.

`csmSetupAppointments:discoverLegacy` uses the pinned cursor API without a status
filter to inventory all statuses in pages of at most 100. It returns only aggregate
counts and an opaque cursor. Import each candidate separately through the bounded
`importLegacy` action after resolving its source proof. Newly issued compatibility references bind the original
source profile as well as deployment/company/purpose. Existing company-only signed
links remain valid and may still create bookings; a finite import cannot retire
them. Unknown source-unbound deliveries emit an aggregate warning and never seed
or recreate an erased snapshot. Known reviewed chains can still refresh by UID.

Historical company-only candidates need independently verified **original** source
attribution through private `csmSetupAppointments:importLegacy` with `uid`,
`reviewedProfileId` and a bounded `sourceEvidence` reference. Current email alone,
current membership and company ownership are not source proof. Existing bindings
are never reassigned by imports. Invalid/rotated signatures, unavailable history,
missing/deleted sources and unprovable attribution remain hidden. Review the
aggregate unattributed/unresolved counts and accept remaining continuing-link
coverage gaps before claiming complete historical/future coverage. No initialization
or provider mutation is automatic during local development.

## Backend contract

`csmBookings.ts`, `csmCal.ts` and `csmBookingValidators.ts` implement the fixed
`juliennewman/julien` event (ID **2928313**). No client-supplied attendee, event or
company is authoritative. Setup display reads require `manageTemplate` and no
completed setup booking, and may run before a template exists. New setup bookings
additionally require an active template; support requires completed setup. Reads and mutations derive membership from authentication.
Scheduled senders recheck the original profile, membership, company, deletion
markers and purpose directly, since scheduled functions do not inherit JWT auth.

Cal endpoint versions are pinned independently: event configuration `2026-06-12`,
slots `2024-09-04`, create/direct booking read `2026-02-25`, cursor-paginated booking
list `2026-05-01`. The default duration currently is 10 minutes. The provider
configuration gate refuses paid, approval, recurring, OTP, required extra fields,
seated or unsupported-location events. Display configuration and slots dispatch
concurrently, with browse duration omitted to use Cal's event default; returned
ranges must match the validated duration. Missing/invalid configuration finishes
without waiting for slots. Every sender still reads fresh configuration and slots
with explicit duration before the live eligibility claim and one create POST. Cal's hidden built-in title is generated
by Cal and needs no invented attendee response. Changes to event workflows must
be assessed before enabling them; no automatic bypasses or fabricated answers
are sent. The event's per-attendee active-booking limit is disabled in Cal, allowing
multiple upcoming calls. The app retains handling for Cal's active-booking-limit
rejection in case the setting is re-enabled.

The `csmBookingAttempts` table is a durable **creation receipt**. Our app owns the
request and first accepted confirmation; Cal owns the appointment afterward.
A confirmation stores `{ uid, start, end, confirmedAt }` and is absorbing: later
cancellation/rescheduling cannot change it or undo the company's permanent Support
promotion. No completed appointment graph, local occupancy or booking-history UI
is maintained. A fresh operation consults Cal again; replay of an exact operation
returns that operation's original outcome, even if the appointment later changed.

Receipts retain immutable ownership, mode, operation ID, original UTC time and
timezone, plus sender/watchdog identities and compact outcome evidence. Indexed
reads deduplicate exact operations and guard membership-wide unresolved work across
modes/tabs. Insertion and scheduling are atomic. Attendee identity is verified on
the server. Name is erased once the sender is terminal; email is erased from
confirmed receipts only after sender termination. Unknown/failed receipts keep the
original email for exact scoped late-positive recovery until account/company
deletion. Current profile email is never substituted into recovery.

States remain `queued`, `submitting`, `unknown`, `booked`, `failed`. The sender
preflights current configuration/availability, atomically claims queued work, and
makes one bounded create POST. The provider transport admits every actual request
against the same shared 80/minute, capacity-12 budget, including sender, webhook,
operator health, status/discovery and refetches. Calendar/status/booking membership
quotas remain separate. Dispatch is marked immediately before fetch, after request
construction and budget admission. Ambiguous claim acknowledgement cannot authorize
dispatch. There is no automatic POST retry, provider idempotency claim, receipt TTL
or time-based unlock.

Accepted creation and the first setup timestamp commit together. Explicit proven
noncreation releases a guard; unknown errors, malformed responses, timeouts and
possibly dispatched work remain unknown. The 55-second watchdog fences never-claimed
queued work, makes stalled submissions unknown and records terminal sender evidence
while scheduled-job history is available. Terminal execution alone cannot prove
remote noncreation.

The mutation acknowledges `{ attemptId, operationId }`; only the live query writes
UI receipt state. Intent arguments and UUID are frozen before awaiting. Each new
binding generation replaces its subscription/deadline, and stale mutation, query,
focus and Check continuations cannot affect it. Until bound, Check replays the same
application mutation/UUID; it never retries a Cal POST. Once bound, Check performs
read-only recovery. A mismatched pending query or timely null cannot release an
unacknowledged intent. Explicit current acknowledgements may adopt another tab's
unresolved operation. Reopening restores unresolved work.

Recovery is bounded to three discovery pages of 100 and nine unique explicitly
linked UIDs, including attribution. It validates fixed event, original attendee,
requested UID, exact signed attempt anchor, original root time and every link.
Only fresh authenticated API facts are used. Cycles, branches, absent nodes, caps,
malformed links or empty discovery leave uncertainty. Missing/null/empty-string
links are absent; other malformed types or strings over 200 characters invalidate
the whole record. A pending leaf remains unknown; an accepted leaf confirms.

For automatic cancellation/rejection release, `beginRecovery` first persists
terminal sender evidence and returns `{ attemptId, sendJobId, kind, observedAt }`.
Every provider fact used negatively must be read afterward; settlement compares
all proof fields against the current receipt. Attribution reads made before the
attempt is known are refetched after this observation. A sender becoming terminal
between an earlier read and settlement is insufficient. Failed receipts can accept
scoped late positives, but negatives cannot rewrite them; booked is immutable.

## Credentials and webhooks

Store these only on the matching Convex backend, never in public Vercel variables:

- `CAL_API_KEY`: organizer-owned Cal credential, needed for configuration,
  availability, creation and recovery reads.
- `CAL_WEBHOOK_SECRET`: independent random secret per deployment, shared only with
  that deployment's Cal webhook. Rotating it invalidates old signed references.

Each Cal webhook uses the default payload, version **2021-10-20**, with
`BOOKING_CREATED`, `BOOKING_REQUESTED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`
and `BOOKING_REJECTED`. Keep organizer, type and UID; metadata may be absent. URLs:

- Development: `https://disciplined-squid-496.convex.site/cal/webhook`
- Production: `https://befitting-lyrebird-846.convex.site/cal/webhook`

The HTTP handler bounds raw payloads at 256 KiB and verifies `x-cal-signature-256`,
fixed organizer/event, deployment and purpose. The legacy `dinuCsmReference` company
signature remains compatible with earlier clients. Native `dinuCsmAttempt` adds a
separate signature over deployment, company, purpose, original start and attempt
ID. Exact valid native hints for confirmed setup receipts durably enqueue current-state
refresh; confirmed Support receipts retain their existing behavior. Missing metadata
first checks known snapshot UIDs, then bounded authenticated link attribution.
Unconfirmed native attempts retain fresh creation recovery. Invalid purported
native references never fall through to legacy promotion. Provider failures remain
retryable HTTP 503 responses. Native webhooks use the same creation-outcome reducer
as API responses/status checks. Requested native bookings never show a
false confirmed success. Legacy signed Created/Requested/Rescheduled deliveries
retain their historical one-way setup completion policy. Unrelated events are
acknowledged without writes. Late events cannot recreate deleted company/profile
or attempt records.

On November 6, 2026, the organizer credential was configured on current dev and
production; a separate production webhook secret and both current webhook URLs
were configured and read back active with all five triggers. The older
`scrupulous-squirrel-986` subscription was left unchanged. Configuration alone does
not deploy native booking code or prove end-to-end delivery. Synthetic unsigned
bookings cannot prove company attribution.

## Operator recovery

The designated operator needs access to the correct Convex deployment, its logs
and Cal's organizer booking records/support. Julien already has deployment access;
provider investigation access must also be available. Use the same deployment for
all inspection and resolution. Production writes require explicit authorization.

For a read-only provider health check, run private `csmBookings:providerStatus` on
the intended deployment. It returns configuration readiness, default duration,
conferencing provider and the next eight days' slot count, with no attendee data.

1. Inspect private `csmBookings:read`; keep revision, original time, attendee and
   sender job ID private. Historical lineage, when present, is a locator only.
2. Call `csmBookings:beginRecovery` before investigating negative evidence. Retain
   its updated revision and terminal `proof`. Scheduled-job history lasts seven
   days; the watchdog normally observes it within thirteen minutes. Missing proof
   cannot authorize automatic or operator negative release.
3. Use **Check booking status** or private `csmBookings:recoverWebhook` with the
   exact signed attempt `reference` and a known `uid`. These fetch authenticated
   facts and never send a creation request. A complete accepted, scoped chain can
   confirm even after an earlier safe failure.
4. If recovery remains unknown, obtain provider investigation confirming creation
   did not occur and cannot later complete **after** the terminal observation.
   A timeout, terminal action or empty list is insufficient.
5. For that negative conclusion only, call `csmBookings:resolveUnknown` with
   `attemptId`, the updated `expectedRevision`, unchanged terminal `proof`, bounded
   `operator`, restricted `evidence` reference and `reason`, plus
   `{ kind: 'notCreated', basis: 'providerInvestigation' }`. Reinspect if raced.
   For a positive operator conclusion, `csmBookings:resolveConfirmed` takes the
   current `attemptId`, `expectedRevision`, `uid` and bounded operator/evidence/reason.
   It fetches Cal directly and requires an accepted booking with fixed event,
   original attendee and exact signed attempt metadata. This can confirm a signed
   accepted record beyond the automatic chain cap; unsigned facts still require
   complete bounded link verification. Confirmation, permanent setup promotion and
   compact operator attestation commit together with a revision fence.
   Old `{ kind: 'booking', bookings: [...] }` inputs to resolveUnknown only schedule
   authenticated recovery from bounded UID hints. Normalized arrays and operator
   text cannot confirm or release a request. No appointment graph is stored.
6. Preserve receipts. Never delete one or replay a POST to unstick a user. A later
   scoped positive may still confirm, and the setup timestamp never clears.

Account deletion drains attempts by profile in bounded batches; company deletion
has an explicit indexed cleanup phase. Both cancel queued jobs and remove attendee
snapshots. Account erasure drains these receipts before ownership-successor work
can pause; already-paused deletion markers can resume this bounded drain without
unpausing ownership recovery. In-flight external requests may already have been accepted by Cal;
provider-owned invitations remain subject to Cal's lifecycle/privacy controls.

## Release and verification

Ship this additive backend/schema before the acknowledgement client. New operations
require `receiptProtocol: 'creation-v1'`. A stale SPA receives an existing error
instructing a full page reload before it can insert/schedule; reopening the modal
alone does not reload cached app code. Exact old-operation replay and unresolved
adoption retain a temporary legacy-view adapter. Remove that return branch only
once obsolete clients/invocations are retired.

Historical failed rows without explicit failure evidence gate **new operations for
that membership** through the temporary
`by_membershipId_and_state_and_failureBasis` index; replay/recovery stay available.
This data-driven gate avoids a global booking outage while maintenance is pending.
On the explicitly authorized target, invoke private `csmBookings:maintainReceipts`
with `{ cursor: null }`, then its returned cursor until `isDone`. Each native page
has at most 25 rows and reports scanned/changed/blocked counts. It observes terminal
senders, makes unproven old failures unknown, converts justifiable accepted legacy
leaves into immutable confirmations using the old observation time, erases resolved
graphs and the obsolete eventTypeId constant, and minimizes terminal attendee data.
It never schedules a sender, changes operation/job identity, retries queued work or
re-promotes setup. Confirmed setup rows also seed current-state snapshots and their
read-only refresh jobs when absent. Re-run a full pass to verify convergence. `blocked` identifies
booked rows whose confirmation cannot safely be converted; retain those documents.

No maintenance is automatic. Retain optional legacy graph/review/operator fields
until their own rows and old invocations permit contraction; unresolved historical
seeds need not block unrelated field removal. Once no unclassified failures remain
and obsolete writers are retired, remove the temporary gate/index. Remove the
optional eventTypeId validator independently once its own field inventory is empty.
Remove legacy settle/fail/read adapters only after older scheduled invocations are
terminal. Production rollout/maintenance requires explicit authorization.

An old mounted embed or previously issued external Cal URL cannot obey the native
request guard: one app-controlled dispatch per attempt is not provider-wide
exactly-once booking. Roll back only to a guard-aware build or disable new entry
while preserving receipt/recovery functions.

Required automated checks: `npm run verify` (lifecycle, performance assertions,
application types and production build), plus separate
`npx tsc --noEmit -p src/convex/tsconfig.json` for backend types. CSM resource,
provider and preload checks cover cache reuse, mocked provider calls and compiled
Svelte/jsdom behavior; see [performance checks](performance-checks.md) for detailed
guarantees. These do not prove actual Cal booking execution, meeting-link generation
or native browser interaction.

Manually verify: no attendee form; explicit inline Book; mobile/text zoom; all grid
keys and focus; timezone/DST; setup/support/repeat calls; invitation and video link;
content/error paint gating; stale sessions; competing tabs and slots; lost mutation
acknowledgements and lost provider responses; unknown recovery; duplicate/out-of-order
webhooks, cancellation/rescheduling before confirmation and unchanged historical
receipts after confirmation; deletion; manual Close
and collapsed launcher. No automated check may replace a real attributed booking
and durable support state after refresh. Do not make real bookings merely to run
the repository checks.

Provider references: [slots](https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type),
[create](https://cal.com/docs/api-reference/v2/bookings/create-a-booking),
[recovery list](https://cal.com/docs/api-reference/v2/bookings/get-all-bookings),
[event configuration](https://cal.com/docs/api-reference/v2/event-types/get-an-event-type),
[webhooks](https://cal.com/docs/developing/guides/automation/webhooks),
[Convex scheduling](https://docs.convex.dev/scheduling/scheduled-functions).
