# Split booking and Meet preparation

Implemented locally on 2026-11-13. The loading screen shows a spinner and “We’re booking your call…”. Setup and support introductions hide during submission. Confirmation advances as soon as the accepted booking is committed; meeting preparation never gates upload or changes the booking receipt back to unbooked.

## Hosted provider check

Used separate hidden events and the organizer's controlled Gmail plus-address. The original event was inspected and left unchanged. All temporary bookings are cancelled and temporary event types deleted. Raw evidence is private session material under `/tmp/split-booking-az4r_wpw/provider-experiment.json` and `provider-followup.json`; it contains calendar/attendee details and is not committed.

| Request | Samples (seconds) | Median | Slowest |
| --- | --- | --- | --- |
| Create with placeholder | 1.503, 1.862, 1.457 | 1.503 | 1.862 |
| Create with Meet | 3.689, 3.898, 3.816 | 3.816 | 3.898 |
| Add Meet after creation | 3.747, 2.971, 3.171 | 3.171 | 3.747 |

The measured create median improved by 2.313 seconds (about 61%). These are sequential controlled API timings, not application click-to-confirmation measurements or a production latency guarantee. Slot/configuration reads and initial calendar-event creation remain on the confirmation path.

Each split booking was accepted with the literal location “Video link to follow” and a Google Calendar reference. PATCH `bookings/{uid}/location` (`2024-08-13`) returned Google Meet; authenticated GET (`2026-02-25`) exposed the same URL. UID, start/end and Google Calendar reference stayed unchanged. The split PATCH does not add a separate video reference, so readiness does not require one.

A further check rescheduled a placeholder booking before Meet preparation. Cal returned reciprocal old/new UIDs, preserved signed-metadata-shaped association and the placeholder, and allowed Meet preparation on the successor. An authenticated `calendars/google/event/{eventUid}` read returned source Google, the expected attendee/time and the same Meet URL as the booking. The worker uses that calendar read before writing and before marking ready.

No browser, actual meeting join or inbox inspection was performed. We did not force Google's pending conference state, race cancellation/rescheduling against an in-flight PATCH, establish whole-endpoint PATCH idempotency, or measure application click-to-confirmation/confirmation-to-ready. Cal's endpoint sends another attendee notification; `notifyHosts:false` suppresses host notification only. Notification presentation and acceptability need the user's check.

## Backend contract

`csmCal.configuration` recognizes a normal single integration location (existing conference-at-create behavior) or exactly Google Meet plus `attendeeDefined` (split behavior). The latter creates with the explicit placeholder. Ownership, free event, duration, booking-field and confirmation checks stay enforced. Configuration/slot checks are not removed or cached.

The sender freezes the split policy in its claim transaction before POST. Common accepted settlement atomically stores confirmation, seeds setup eligibility and inserts/schedules one UID-keyed preparation. Recovery and operator acceptance use this same boundary. Pre-existing attempts without that marker cannot gain preparation jobs.

`csmMeetingPreparation` owns bounded, revision-fenced claims, scheduled watchdogs, periodic scheduler repair, strict original scope/metadata/attendee-hash checks, Google Calendar reference/event validation and matching Meet URLs. A durable reservation precedes PATCH. Only a proven local predispatch failure can release that reservation automatically; ambiguous writes reconcile through GET and enter `needs-attention` after a finite budget. Manual locations and other providers are preserved. Cancellation, supersession, deletion and changed times stop preparation. A reciprocal authenticated reschedule successor can receive its own preparation. Profile/company deletion drains preparation rows and scheduled work.

Internal operator functions `csmMeetingPreparation:needsAttention`, `:inspect` and `:repair` use Convex admin credentials. Inspect by exact `preparationId`; explicit repair requires its current `revision`, bounded `operator/evidence/reason`, and `previousWriteFinished:true`. Investigate the original dispatch/calendar first: that assertion is human evidence, not provider idempotency. Repair still reads and preserves a manual location. Use the existing exact-target deployment guard; production mutations require fresh explicit authorization. No customer-facing repair control is added.

## Activation sequence

This is a local implementation, not a production release. Keep the shared Cal event's single Meet location unchanged. Its direct booking/reschedule pages must not expose an unowned promised-link placeholder.

1. Deploy the additive backend/client through the separately authorized release process. A single-location event continues its existing create-with-Meet path, so deployment and configuration can be ordered safely.
2. Create a dedicated hidden app event with the verified organizer/calendar, matching schedule, duration, booking fields and policies. Configure exactly `{type:'integration',integration:'google-meet'}` plus `{type:'attendeeDefined'}`. Use this event only through the app; do not publish its native Cal booking URL. Existing native calendar reschedule links remain supported for app-associated bookings.
3. Set `CAL_EVENT_TYPE_ID` to this dedicated event and verify `CAL_ORGANIZER_ID`, API credentials, immutable metadata signing key and delivery secret. Preserve the existing historical-reference rollout documented in `docs/assisted-template-setup.md`; this feature does not replace that migration.
4. Configure the signed Cal webhook subscription for the dedicated event and include `BOOKING_LOCATION_UPDATED` alongside the existing create/request/reschedule/cancel/reject triggers. Verify delivery to the existing `/cal/webhook` endpoint and its actual configured URL from `src/convex/http.ts`. Do not point at a guessed deployment URL.
5. Perform an app booking and inspect accepted confirmation, immediate upload access, preparation ready, matching Cal/Google Calendar links and both attendee emails. Check delayed completion and cancellation/reschedule races before production activation. Extra attendee email is a release acceptance check.
6. Inspect `needsAttention` when preparing support calls; finite reconciliation never silently retries an ambiguous PATCH. Deactivation is the prior single-location event configuration for new attempts; retained split jobs continue to reconcile using their frozen scope.

## Validation

Existing provider/performance fixture now uses both proven locations. No tests were added or expanded. `npm run test:perf` passed all 7 files / 36 checks; Convex TypeScript checking passed. An initial build exposed incompatible operator CLI type additions; those additions were removed. Final application/tools checks and production build passed with the calendar verification and modal changes. Convex types and the required performance suite passed after the final reschedule guard adjustment. An isolated local Convex backend accepted the schema/functions/components; no cloud deployment was changed. The focused existing CSM component suite currently fails 4 of 8 checks (missing slot controls in three cases, missing availability refresh in one); audit must classify and address their relationship to this change. Final audit results are recorded below when complete.

Automated checks cover the existing preflight, scoped access, duplicate booking admission, explicit duration, scheduling/saving/cache guarantees. They do not establish remote latency, Google pending behavior, endpoint idempotency or invitation delivery. New worker edge cases require review and controlled integration checks; no additional test coverage was authorized.

## Focused audit remediation

The backend audit fixes are implemented locally. A signed native-reschedule hint can now move an exhausted, attention or stopped preparation into durable successor-only discovery. A different hinted successor opens one finite window; duplicate hints retain that target's passes and expiry. Discovery preserves the old UID's write reservation, Calendar identity and repair evidence, revokes earlier claims and replaces scheduled work. It can read after the old start, but cannot reserve or dispatch another old-UID write. Only authenticated reciprocal old/new booking observations can seed an upcoming accepted successor, after checking live ownership, the booked split policy/reference and setup supersession again. The successor receives its own independent preparation window. Operator repair in discovery mode also preserves the old reservation.

Initial PATCH now additionally requires actual Google Calendar locations to be an explicit empty array or the sole exact owned placeholder. Missing, malformed, manual, other-provider and mixed locations enter attention before write reservation. An actual Meet while Cal still shows the placeholder is preserved as a discrepancy. Ready verification uses the same location normalization and requires the matching Meet with only compatible Google dial-in companions. The provider endpoint projects conference entry points ahead of its raw location field: raw edits hidden by that mapping are not proven detectable.

After these fixes, `npm run test:perf` passed all existing 7 files / 36 checks, `npx tsc --project src/convex/tsconfig.json --noEmit` passed, and `npm run build` passed application and tools checks plus production output (Svelte reported zero errors and warnings). The final backend sources/schema pushed successfully only to the existing isolated local validation target `local-julien_newman-dinu_app` at `127.0.0.1:3210`; its dummy issuer/configuration was preserved. No cloud deployment or real provider/environment configuration changed. No tests or assertions were added, expanded or weakened. Terminal successor and Calendar discrepancy cases were traced in code; the existing suite does not directly prove these new cases. Component readiness maintenance and independent final integration validation are tracked separately in the audit artifacts.

Production activation still follows the sequence above. Hosted pending behavior, cancellation/reschedule during in-flight provider calls, actual meeting join/inbox delivery, endpoint idempotency and application confirmation latency remain unverified. A provider request already admitted by a claim cannot be atomically cancelled by a later webhook; revision fencing prevents that claim from reserving, finishing or seeding after it is superseded. User screen checks remain outstanding.

## Limited provider regression coverage

Following explicit authorization, added two tests to `tests/backend/csm/provider.test.ts` using the existing in-memory Convex and mocked-fetch setup. The successful flow confirms exactly one placeholder creation POST, a booked attempt before the Meet update completes, and readiness only after Cal and the actual Calendar event expose the same Meet URL. The timeout flow exercises the request's 20-second abort, retains the confirmed booking and durable write reservation, and reconciles through a still-visible placeholder to eventual Meet readiness using GETs without a second PATCH. Retry passes are driven explicitly with fake time; this does not test scheduler delivery.

`npm run test:perf` passed all 7 files / 38 checks, including these two additions. No application/backend implementation or dependencies changed for this coverage. These mocked-provider tests do not establish live Cal/Google behavior, invitation delivery, meeting joinability, latency, or the remaining reschedule/cancellation/manual-edit races.
