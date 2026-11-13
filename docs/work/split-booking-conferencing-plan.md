# Confirm the booking before creating its meeting link

Status: implemented locally, under focused audit. See [implementation and provider evidence](split-booking-conferencing-progress.md) for measurements, verification limits, and the deployment/configuration sequence. Production behavior is not changed by these local edits.

Reviewed again on 2026-11-13 against Cal's current OpenAPI schema, Google's Calendar documentation, our adapter, and Cal's published historical implementation. The two-request API design is supported. The controlled hosted check measured a material create-latency reduction and verified the same Google Calendar event acquired the Meet link. Outstanding provider race and notification checks remain explicit in the implementation report.

## Intended behavior

1. The user chooses a time and sees a spinner with “We’re booking your call…”.
2. Cal creates an accepted booking and its Google Calendar event, with an explicit non-conferencing location explaining that the video link will follow.
3. We persist that accepted booking and immediately continue to the existing booked/upload experience.
4. A durable backend job asks Cal to change that same booking’s location to Google Meet. Cal provisions the conference, updates the calendar event, and notifies attendees.

Booking confirmation and meeting-link preparation are separate states. A delayed or failed meeting-link update must never turn an accepted booking into an unbooked call, block template uploads, or invite another booking.

The initial request still creates the calendar event. Adding Meet later uses that existing event; this dependency fits the sequence and does not invalidate the split. It means we are moving conference preparation out of the confirmation path, not moving all calendar work out of it. Do not claim that the whole observed five-second create request will disappear.

## 1. Prove the provider flow and measure the benefit

Use a dedicated development Cal event and controlled attendee inbox when implementing this plan. First inspect the actual event’s conferencing integration; current code permits several integrations, so Google Meet is not yet established from configuration evidence.

- Configure the event with `attendeeDefined` and the intended installed integration. The current [event-type schema](https://cal.com/docs/api-reference/v2/event-types/create-an-event-type) accepts `{ "type": "attendeeDefined" }`; the [booking schema](https://cal.com/docs/api-reference/v2/bookings/create-a-booking) accepts `{ "type": "attendeeDefined", "location": "Video link to follow" }`. These are distinct configuration and request shapes. Verify the resulting invitation reads naturally. Do not invent a dummy meeting URL, use an address for a video call, or rely on an omitted location.
- Create a booking with that explicit initial location. Verify accepted status, the occupied time, an actual organizer Google Calendar event/reference, and the absence of conference provisioning, including Google's automatic-conferencing setting. A connected account alone does not prove that this booking has a usable calendar event.
- PATCH the accepted booking's location to `{ "type": "integration", "integration": "google-meet" }`, after confirming that Google Meet is the intended integration. Verify that its UID, time, attendee, and external calendar-event identity stay the same, and that the calendar invitation and Cal booking acquire the same working Meet link. Do not treat an arbitrary URL or an internal integration label as success.
- Exercise delayed conference creation and establish which authenticated Cal read exposes eventual completion. Google's [Calendar guide](https://developers.google.com/workspace/calendar/api/guides/create-events#conferencing) states that conference creation can initially return `pending`. A 200 response is not sufficient evidence of a usable link. Do not assume polling the Cal booking will discover a link unless the controlled check establishes that Cal synchronizes it. If the Cal-only flow cannot reliably finish or expose completion, revise the provider design before proceeding to application implementation.
- Measure create latency separately from location-update latency and compare several comparable bookings against the current integration-at-create flow. Record median and slower requests, not just one favorable run. Also measure click-to-confirmation and confirmation-to-link-ready.
- Inspect the initial invitation and subsequent location-change email. The extra attendee notification is a documented consequence of this endpoint; `notifyHosts: false` suppresses host emails only.

The observed booking took approximately 6.2 seconds, with roughly 5.2 seconds in the create request. We have not measured how much of that time conferencing consumes. Keep this as a measured optimization: if create remains equally slow, report that result before rolling it out.

Cal's [published integration handler at the integration-support commit](https://github.com/calcom/cal.diy/blob/1a140c7f74c3488ad22eb69c747ac3aa58997b3f/apps/api/v2/src/ee/bookings/2024-08-13/services/booking-location-integration.service.ts) checks for a Google Calendar reference and falls back to Cal Video when none exists. Its [Google Calendar adapter](https://github.com/calcom/cal.diy/blob/1a140c7f74c3488ad22eb69c747ac3aa58997b3f/packages/app-store/googlecalendar/lib/CalendarService.ts) requests conferencing during event insertion and can perform a subsequent event patch once it has a Meet link. This suggests work the split could defer, but neither file proves today's hosted implementation or its timing. Validate the calendar reference, actual returned provider, eventual completion, and latency on the hosted API. The current event's authenticated configuration has not been inspected; an unauthenticated read returned 401 during this review.

Provider contract: [create a booking](https://cal.com/docs/api-reference/v2/bookings/create-a-booking) accepts a configured location; [update booking location](https://cal.com/docs/api-reference/v2/bookings/update-booking-location-for-an-existing-booking) provisions integration conferencing and updates the calendar. The documented PATCH API version is `2024-08-13`; creation currently uses `2026-02-25`. Validate and pin each endpoint’s version independently.

Phase 1 is a decision point. Proceed with the application changes below only after confirming a material reduction in confirmation latency, reliable link completion, and acceptable extra attendee email. Otherwise retain normal conference-at-create behavior and the improved loading screen.

## 2. Separate initial and final locations in the adapter

In `src/convex/csmCal.ts`:

- Replace the exactly-one-integration-location assumption with explicit validation and selection of the configured initial location and final conferencing location. Preserve event ownership, free-event, duration, booking-field, and confirmation-policy checks.
- Read back the actual configured event before choosing the validation representation: the current event-type output schema can represent custom locations as `unknown`, so configuration input and output are not interchangeable. Keep validation restricted to the proven initial location and intended integration.
- Return both locations from configuration. Pass the initial location explicitly in `csmBookings.send`; retain the existing attendee, signed metadata, and booking validation.
- Give the request helper an explicit HTTP method so it supports GET, POST, and PATCH without inferring all writes as POST. Preserve rate limiting, bounded responses, timeouts, and secret-safe errors.
- Add a narrowly scoped location-update adapter with strict UID/event/attendee ownership checks and validated response parsing. The current `ProviderBooking` parser discards location/conference information; add a separate validated preparation observation or extend that boundary deliberately. A successful HTTP response without authoritative evidence of a usable conference from the intended provider is not enough to mark preparation complete.

Do not bundle speculative availability-check removal or configuration caching into this change. Those are independent optimizations.

## 3. Persist confirmation and background work together

In `csmBookings.settleCreation`, the schema, and booking validators:

- Persist a meeting-preparation record keyed uniquely by the confirmed booking UID, separately from booking confirmation and setup eligibility. Suggested states: `pending`, `running`, `unknown`, `ready`, `needs-attention`, and `stopped`.
- Atomically record the accepted booking, seed setup eligibility, create its preparation record, and schedule the first preparation action in the same mutation. This must cover normal API success, webhook/GET recovery, and operator-confirmed recovery through the shared settlement path.
- Repeated settlement or duplicate webhooks must not create another preparation job or conference. Use a unique lookup and mutation-owned claim/revision so only one worker can dispatch for a UID.
- Persist the split-flow marker and chosen location policy on the attempt before POST dispatch, so webhook recovery and operator settlement know whether preparation is required even if the sender never receives a response. Mark only these newly split-flow bookings as needing preparation. Existing confirmed bookings with meeting links must not acquire background updates during rollout.

Use Convex’s existing scheduler for durable dispatch and bounded recovery. No browser-owned promise or detached fetch should own conference creation. Keep preparation errors, timestamps, attempts, next retry, and any validated meeting URL server-side unless an existing product surface needs them.

## 4. Provision with reconciliation before retries

Implement a dedicated internal action/mutation module, for example `src/convex/csmMeetingPreparation.ts`:

1. Claim the pending UID and verify that the booking still belongs to the company/event and remains accepted, current, and upcoming. Stop for deletion, cancellation, rejection, supersession, or a changed UID; never follow a different booking blindly.
2. Read Cal's current booking using the completion surface established in phase 1. If it already has the intended usable conference, mark ready. Distinguish our placeholder, a provider integration label with no link yet, the intended conference, a different provider/fallback, and a manual location. A provider label after PATCH is an incomplete outcome to reconcile, not an instruction to repeat PATCH or proof of a manual edit. Preserve manual changes and surface discrepancies rather than overwrite them.
3. If it still has our exact placeholder, dispatch PATCH to the final integration. Revalidate ownership, status, UID, and the resulting conference before recording success. Keep the user’s booked state intact throughout.
4. For a definitive pre-dispatch failure or rate limit, schedule a bounded retry with backoff. For a timeout or ambiguous provider result, mark unknown and reconcile by authenticated GET before considering another write.
5. Do not assume PATCH is idempotent. A stale worker claim or an unchanged GET immediately after a timeout does not prove the original provider request cannot complete. A stable Google conference request ID in historical code does not establish idempotency of the whole Cal endpoint, including calendar writes, emails, and webhooks. Verify repeat-call semantics in the controlled provider check; absent a safe retry guarantee, continue bounded reads and escalate to `needs-attention` instead of blindly generating another conference/email.
6. Retain a durable scheduled check so an action interruption cannot strand `running` forever. Recover expired claims through reconciliation, with revision checks preventing late workers from overwriting newer decisions.
7. Bound recovery by retry count and call time; unresolved jobs become actionable through the existing operator tooling. Provide an authenticated, explicit repair action. Do not silently abandon an accepted call without a link.

Handle `BOOKING_LOCATION_UPDATED` in the existing signed webhook receiver as a hint to refresh preparation through authenticated provider reads, and add the trigger to the provider webhook subscription. Preserve the existing cancellation/reschedule authority. Reconcile cancellation or rescheduling that races with PATCH; a late response must not resurrect a superseded booking or replace a newer link in our state. Local revisions cannot cancel a write already running at Cal, so verify provider-side calendar behavior during those races as well. Audit whether Cal's own reschedule flow preserves or regenerates the location and apply the same invariant to the current UID.

## 5. Keep the user flow simple

The loading-screen portion is implemented now in `CsmBooking.svelte`, `TemplateSetup.svelte`, and `TemplateSetupLayout.svelte`:

- Normal submission and queued/in-progress receipts show the spinner and booking message.
- Introductory booking instructions, time-picker description, duration, selected-time card, and status-check controls are absent from the normal loading state.
- Existing reactive confirmation still advances the flow automatically.
- Recovery controls remain available for an unknown provider outcome, an uncertain replacement, or an unacknowledged mutation after its deadline. Transport errors retain their retry path.

When implementing split booking, retain that confirmation boundary. Show “Your call is booked” as soon as accepted booking evidence is committed. Use a short booked-state sentence such as “Your video link will be added to your calendar invitation shortly” wherever existing copy would otherwise imply that the link is already ready. The meeting-preparation job must not gate the upload step or keep the loading screen mounted.

## 6. Validate and release

- Maintain existing provider/performance fixtures and assertions for the changed location configuration, explicit HTTP methods, and settlement scheduling. Do not add tests or expand coverage without the user requesting it. Preserve all existing guarantees.
- Run the required `npm run test:perf`, application/tools checks, and Convex type checks. Use the existing focused booking component checks where relevant; report any baseline failures separately. Build before release.
- Review the accepted → preparation-pending → ready flow and the timeout, duplicate dispatch, cancellation, replacement, deletion, and manual-location paths. State which are established by existing assertions and which still require controlled provider or user checks.
- The user checks the actual loading and booked screens. Local mocks and type checks cannot prove Cal latency, email delivery, conference creation, or Google Calendar behavior.
- Coordinate event configuration and deployment so the new validator and both required locations agree; the current validator rejects multiple locations. Follow deployment guard instructions when a deployment is actually authorized. Keep normal conflict checks and signed booking association intact.
- Audit direct Cal booking and reschedule pages before changing a shared event: adding a second location can expose a location picker. Our worker only owns bookings associated with our attempts. Do not introduce a promised-link placeholder into another entry point that has no preparation job; use an app-specific event if needed and update event identifiers, ownership checks, signed associations, and existing fixtures consistently.
- Release only after the controlled flow produces real links reliably and shows a useful confirmation-time improvement. Document the additional attendee email and the measured remaining booking latency.

The original planning phase made no provider or backend changes. The subsequent authorized implementation and temporary provider experiments are recorded in the linked progress document.
