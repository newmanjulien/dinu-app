# Assisted template setup

Admins book the setup call in the template fallback on `/template`,
`/template/buyers` or `/contracts/new`. After provider confirmation, they may upload
a DOCX or wait for the call. A valid upload is saved for Julien; it does not unlock
the template editor or instructions. Help stays available on demand.

Cancel before release: booking returns with the exact current appointment ID/UID,
and the pending file stays saved. Rebooking restores waiting. Ending the call or a
temporary provider-refresh failure does not undo accepted booking qualification.
Release immediately completes template setup, even before the setup call starts or
ends. The released source is authoritative: the setup-call reminder disappears,
and required setup booking/rescheduling is no longer available. Existing appointment
history is retained and ordinary support calls remain available. Cancellation or
provider-refresh failures cannot relock the template or restore its setup reminder.
Instructions and the other onboarding steps still have their own completion checks.
Pending files expire 90 days
after upload, including while waiting for rebooking; retry reuse never extends this.
Replacing a pending file retires the old one only after the new import succeeds.

## Select the target

These are privileged operator instructions, not validation steps. No command below
deploys code; never add `--push`. Use already provisioned code and credentials.
Identify and announce the exact target before running any command. When an agent
executes production operations, apply the [deployment target guard](../.agents/skills/convex-deploy-guard/SKILL.md):
fresh explicit consent must name the action and production deployment. Local
implementation approval does not authorize production release.

Set `ASSISTED_CONVEX_URL` and `ASSISTED_CONVEX_ADMIN_KEY` privately for exactly one
target, and check that they agree before invoking the CLI:

| Target       | URL                                                        | Credential                                                     |
| ------------ | ---------------------------------------------------------- | -------------------------------------------------------------- |
| Local        | Exact running backend URL, such as `http://127.0.0.1:3210` | That backend's local admin key                                 |
| Personal dev | `https://EXACT-DEV-NAME.convex.cloud`                      | Deployment-scoped `dev:EXACT-DEV-NAME` deploy key              |
| Production   | `https://EXACT-PROD-NAME.convex.cloud`                     | Privileged deployment-scoped `prod:EXACT-PROD-NAME` deploy key |

Use the installed CLI from this repository. Passing both `--url` and `--admin-key`
selects those exact credentials; do not mix in `--prod`, `--deployment` or
`--deployment-name`, or depend on implicit `.env.local` selection. Keep keys out of
logs and shared command transcripts. The generic `scripts/company-convex.mjs`
production-mutation refusal remains unchanged; this runbook does not extend it.

## Inspect, prepare and release

1. Independently confirm the company ID and target. Inspect that exact company:

   ```sh
   npx convex run --url "$ASSISTED_CONVEX_URL" --admin-key "$ASSISTED_CONVEX_ADMIN_KEY" operator:inspectPendingTemplate '{"companyId":"COMPANY_ID"}'
   ```

   The result includes `releasedTemplateSourceId`, a booking summary and at most one
   `pending` record with `pendingTemplateSourceId`, `filename`, `uploadedAt`,
   `expiresAt`, `issues`, `fingerprint` and `originalUrl`. No pending record means
   there is nothing to release. Use its `originalUrl` privately
   to download the DOCX; inspect again if it is unavailable.

2. Normally use the upload as-is. If it needs replacement, correct the DOCX in Word
   and use the same company-admin uploader with existing authorized access to that
   company. There is no operator preparation screen or impersonation flow. Inspect
   again after upload and use the new source ID/fingerprint.

3. Release only the exact inspected source and fingerprint, on the same target:

   ```sh
   npx convex run --url "$ASSISTED_CONVEX_URL" --admin-key "$ASSISTED_CONVEX_ADMIN_KEY" operator:releasePendingTemplate '{"companyId":"COMPANY_ID","pendingTemplateSourceId":"EXACT_PENDING_SOURCE_ID","expectedFingerprint":"EXACT_INSPECTED_FINGERPRINT"}'
   ```

   Success returns `{templateSourceId, versionId}`. Source activation, canonical
   first version and pending-pointer removal commit atomically. The customer's
   current route reveals its normal content reactively, with no Continue action.
   The command sends no new email or notification.

Wrong company/source/fingerprint, replaced or expired pending state, cancelled or
unconfirmed booking, deletion hold, parse errors or existing incompatible template
history refuse release. Reinspect and resolve the actual state; never substitute a
different source or infer confirmation from an ended/hidden header bar. An exact
already-released source/fingerprint retry returns the committed version, including
after later booking cancellation. No wipe, migration or deployment belongs in this
workflow.

## Confirmed setup-call messages

The company’s canonical appointment owns a `confirmedBooking` snapshot: accepted or
cancelled status, UID, start/end, confirmation time, and provider update time when
available. Creation confirmation and validated decisive provider proofs replace the
snapshot atomically. Pending successors, webhook notifications, stale observations,
refresh failures, and retry deadlines leave it intact. Compatible legacy-chain
merges carry the canonical snapshot to the survivor before removing history.

The admin’s existing viewer response includes `company.setupCall`, containing only
`state` (`scheduled` or `cancelled`), `start`, and `end`, or `null`. Reps and released
templates receive `null`. The header uses this response, with the existing route and
account restrictions. It does not subscribe separately or expose refresh status.
Scheduled reminders disappear at their confirmed end time, including on return from
sleep. That does not remove accepted booking qualification. Cancellation has no
expiry; unsuccessful replacement attempts and pending provider reschedules retain
it until a confirmed replacement or release. Booking problems remain beside the
booking controls, whose ownership and duplicate-creation guards remain in force.

### Snapshot and reference reconciliation

This is a separately authorized deployment/data rollout, independent of releasing
one pending template. Use the exact-target rules above; no operation here was run
during local implementation. Backend/client release, env setup, live inventory,
apply passes, provider GETs and browser checks require their own rollout authority.

1. Verify the actual event/organizer numeric IDs and API scope. Configure
   `CAL_EVENT_TYPE_ID`, `CAL_ORGANIZER_ID`, `CAL_API_KEY`,
   `CAL_METADATA_SIGNING_SECRET` and matching delivery-only `CAL_WEBHOOK_SECRET`.
   Setup/support share the event. Preserve the old delivery key privately as
   `CAL_LEGACY_METADATA_SECRET` before rotating it. New/frozen references do not
   depend on today's delivery key; new signing-key rotation affects new attempts.
   Missing config refuses creation without removing confirmed presentation.
2. Deploy the additive backend and matching client, retiring old open tabs. The
   current mutation returns `{attemptId,operationId}` with no receipt negotiation;
   old context/link issuance and settlement APIs are removed. Keep the scheduled
   `csmBookings:recoverWebhook` and `csmSetupAppointments:legacyWebhook` wrappers
   until their old jobs have drained into the durable inbox.
3. Inventory each population separately with `apply:false`:

   ```sh
   npx convex run --url "$ASSISTED_CONVEX_URL" --admin-key "$ASSISTED_CONVEX_ADMIN_KEY" csmMaintenance:normalize '{"population":"attempts","cursor":null,"apply":false}'
   ```

   Repeat for `appointments` and `companies`, following each returned cursor until
   `isDone`. Pages are bounded (25 attempts/appointments, 10 companies). Save
   page-local `legacyIds`, every `unresolved` ID/reason and counts: `convertible`,
   `convertedUnknown`, `enrollmentEligible`, `enrollmentNeeded`. Dry-run changes
   no application data and does no provider IO. Complete observations can recover
   coherent snapshots even when refresh is dirty; a pending marker/date pairing
   cannot supply lost confirmed facts. Company binding requires one coherent owned
   candidate with no uncertainty, never the newest date or an email match.

   Inventory all stored attempts, including already-format2 rows. Historical
   `providerTerminal`/`providerInvestigation` failures with missing or invalid
   sender execution evidence (including `canceled`, `unknown`, `pending` or
   `inProgress` tokens) convert to `unknown`/`uncertain`, retaining lineage and
   review. Only `success`/`failed` execution tokens with the required booking UID
   or bounded operator evidence can retain provider-negative failure authority.

4. Resolve original identity only with authenticated historical proof. The private
   `csmMaintenance:verifyIdentity` takes `target:{kind:"attempt"|"appointment",id}`
   and a known `uid`, performs one provider GET, verifies original historical event,
   host, exact reference and attendee/established appointment association, and freezes
   scope/reference with revision/current-UID fences. It does not create, publish
   confirmation or invent a missing dispatch. Missing proof remains review.
   `csmHistoricalAppointments:discoverLegacy({cursor:null})` separately inventories
   provider pages of all statuses. Import each reviewed candidate with
   `importLegacy({uid,reviewedProfileId?,sourceEvidence?})`; company-only links need
   independently verified original source attribution. Neither current membership
   nor email is sufficient. Preserve unresolved/continuing issued-link obligations.
5. After inspecting dry-run IDs/reasons and obtaining data-pass authority, repeat
   each population with `apply:true`. Apply shares canonical reducers. Existing
   unknown rows without due fields and converted uncertainty enroll GET-only work
   using the same S04 policy, preserving live leases, due/backoff, review and finite
   budget. Missing scope/reference/original attendee stays guarded review. No sender
   is scheduled. `changed`, `convertedUnknown` and `enrollmentAdded` are page-local
   deltas. Repeat complete dry runs after repair; retain every unresolved ID/reason
   for explicit disposition. Inspect `csmSetupReview:inventory` for structural review,
   old lost overflow and remaining released-appointment retirement.

   Complete this separately authorized inventory/apply across every attempt page
   before relying on affected historical initial-setup/support admission, including
   already-format2 failures. Converted unknown rows are fenced by the existing
   indexed pending readers. Deploying the code alone does not repair stored rows;
   local implementation performed no inventory or apply. Preserve existing recovery
   failure counts, due/backoff, live leases and review throughout conversion.

6. Verify the intended admin reminder/setup controls in the browser and provider
   delivery/recovery behavior separately. A failed refresh retains confirmed facts;
   no unknown-status header is added. Release retires appointment maintenance in
   bounded batches while creation outcome recovery continues. History/invitations
   remain. Existing cold display still uses concurrent config/slots GETs and the
   browser's two-minute/eight-entry cache; no server display cache was added. No
   provider-wide exactly-once or slot reservation is claimed.
7. Contract schema only after inventories show no removable legacy values, every
   unresolved obligation is safely retained/converted, old deployed readers/writers
   and scheduled invocations are retired/drained, and old issued links are accounted
   for. Clear stored legacy fields in an authorized bounded pass before removing
   optional schema fields/readers/verifiers. Canonical writers already use only
   `confirmedBooking` and bounded pending hints; `bookingConfirmation`, single hints
   and old receipt unions remain isolated historical input. A finite import alone
   cannot retire an issued URL that may still be used later.

### Reviewed recovery

These private procedures require original evidence and exact-target authorization.
They are not customer controls or automated noncreation decisions. Ten unsuccessful
GET evidence passes enter retained review; quota deferrals do not consume the
budget. A semantic new event may wake one pass without resetting history. Empty
lists, elapsed time, a pending leaf or missing records do not prove noncreation.

For a surviving private receipt, inspect `csmBookings:read` and observe the exact
sender with `beginRecovery`. `resolveConfirmed` needs attempt ID, current
`expectedRevision`, accepted `uid` and bounded `operator/evidence/reason`; it reads
fresh exact-reference/original-attendee provider proof. Negative `resolveUnknown`
requires the current revision and exact returned terminal `proof`, authoritative
original-dispatch investigation performed after that observation, bounded
attestation and `resolution:{kind:"notCreated",basis:"providerInvestigation"}`.
Terminal execution alone cannot release uncertainty; immutable booked receipts
cannot be rewritten. No reviewed operation retries POST.

For an **erased initial creator**, personal proof is gone. Inspect
`csmErasureGuards:inspect({companyId,blocking:true,cursor:null})`. Each bounded
page returns `page`, `continueCursor` and `isDone`; pass every exact returned cursor
with the same company/filter until `isDone`, even after a short or empty page.
Omit `blocking` to include retained nonblocking history, or use `blocking:false`
to inspect that history alone. Account for every blocking row independently.
Call `beginReview({id,identity,expectedGeneration})` for the
exact guard; retain its returned generation and terminal token. The exact sender
must be observably terminal with original opaque dispatch/scope. Missing jobs,
cancellation requests, stored `canceled` tokens or timeouts are not terminal proof.
Account erasure cancels only senders still pending and leaves running actions for
bounded local observation of `success` or `failed`; canceled/unobservable execution
stays in review without release. Only after begin/terminal
observation, investigate that exact possible dispatch exhaustively. Within the
15-minute review window call `resolve` with `id`, `identity`, returned
`expectedGeneration`, exact `terminal`, `investigatedAt`, bounded
`operator/evidence/reason`, literal true `exactDispatchAssociation` and
`exhaustiveOriginalDispatchInvestigation`, and disposition `notCreated` or
`externalBookingExists`. Only proven `notCreated` releases admission. A positive
keeps the company closed and reconstructs no receipt/profile/appointment or
qualification. New evidence, generation change, company deletion or changed sender
fence defeats a stale commit. Missing original investigation proof stays unresolved.

For **appointment cap/overflow**, inspect `csmSetupReview:inventory/inspect` and
call `begin({id,generation,evidenceGeneration,currentUid})`. Retain the returned
lease; with that frozen tuple and lease, call `scan` from cursor null and every exact
returned cursor until `isDone`. Investigate every retained obligation and any old
lost overflow; the first page or nine direct reads are not exhaustive. Within the
30-minute review window call `resolve` with the same tuple/lease, authoritative
`leafUid` and attestation containing bounded `operator/evidence/reason` and literal
true `exhaustive`, `originalAssociationConfirmed`, `coversLostOverflow`. It performs
fresh scoped anchor/current/leaf GETs and uses the normal publisher's ownership,
relevance, generation/evidence-generation, UID, lease and provider-time/conflict
fences. A new leaf additionally needs exact original metadata association; a
non-leaf or older/equal-time contradictory fact cannot publish. Only the attested
frozen evidence generation is dispositioned; bounded cleanup retains new arrivals.
A changed token, release, erasure or supersession requires reinspection. Failed or
incomplete proof stays review with coherent presentation intact.
