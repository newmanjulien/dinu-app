# Replace the booking calendar with a 48-hour time list

Status: implemented. The booking picker now shows a rolling 48-hour time list. Implementation validation passed; remaining verification limits are recorded below.

## Intended behavior

- Show available appointment start times within the next 48 hours, including remaining availability today. This is the working interpretation of “next 2 days,” rather than two calendar dates or two business days.
- Use one chronological list grouped under day headings. A rolling 48-hour window can span three local dates; include all qualifying times under their corresponding headings.
- Remove the calendar grid, month heading/navigation, date selection, and “Find next available date.”
- Keep the existing time selection followed by a Book button, meeting duration, and time zone selector. Use the app's existing styling and inline Tailwind classes.
- Show “No available times in the next 2 days.” when the provider returns no qualifying slots. Keep load errors and provider unavailability distinct from an empty result, with the existing retry behavior.
- Apply this behavior to setup, support, and replacement booking pickers, including the embedded setup flow and support modal.

The window applies to appointment starts: `now < start <= now + 48 hours`. A qualifying meeting may end beyond the cutoff. Weekends do not extend the window. Provider availability, minimum notice, and any narrower provider booking restrictions continue to apply. Changing the displayed time zone changes labels and grouping, not the duration of the window.

## 1. Replace the month-based availability contract

Files: `src/convex/csmBookings.ts`, `src/convex/csmBookingValidators.ts`, and the affected configuration helpers in `src/convex/csmCal.ts`.

- Read `src/convex/_generated/ai/guidelines.md` before implementing Convex changes.
- Introduce one shared 48-hour duration/predicate for availability and new-booking admission so the rule cannot diverge between them.
- Remove the public availability action's `month` argument. The server captures the current instant, computes the cutoff, and requests only that range from the existing slot adapter. Preserve concurrent configuration and slot reads.
- Filter provider results explicitly against the computed instant bounds, even if the provider returns extra slots. Preserve sorting, deduplication, duration validation, authorization, rate limiting, and provider-scope checks.
- Remove `lastDate` from the availability response and the configuration parsing that exists only to bound calendar navigation. Remove the backend date-to-month helper if it has no remaining callers. Provider slot responses remain authoritative for narrower provider restrictions.
- Replace the booking mutation's 370-day admission limit with the shared 48-hour rule. Capture one `now` for each validation. Keep acknowledgement of an existing operation before new-start validation so retries of an already accepted operation retain their existing result.
- Preserve the queued sender's live slot/conflict check and existing recovery behavior. The upper booking bound is evaluated when a new intent is accepted; advancing time only brings an admitted start closer. Do not reject an existing booking, pending receipt, or recovery result merely because it predates this UI change.

## 2. Simplify availability ownership, preloading, and caching

Files: `src/lib/components/chrome/csm-availability.ts`, `csm-preload.svelte.ts`, `csm-dialog.svelte.ts`, and their callers.

- Rename `CalendarSelection` to `AvailabilitySelection` and `initialCalendar` to `initialAvailability`; remove month from their data and cache keys. Rename remaining calendar-resource fields where they now refer to availability rather than a calendar view.
- Update modal, dialog, and template setup callers together. Do not retain a month-compatible API or an unused calendar abstraction.
- Continue keying reads by booking mode, time zone, and replacement identity within the existing workspace-owned resource.
- Preserve request coalescing, the bounded cache, the two-minute ready-result TTL (including empty results), invalidation after booking outcomes, retry after failed reads, and disposal on workspace changes. Late reads must not populate a replacement owner or invalidated entry.
- Filter expired and out-of-window starts whenever cached data is served. Do not extend a cached response's original provider query range: a fresh read supplies newly eligible slots as the window advances.
- While the picker is open, refresh when the cached result expires and on return to a visible tab if stale. Remove elapsed starts and clear an expired selection on a lightweight clock update and immediately before selection/submission. Clean up timers and listeners with the component lifetime; avoid overlapping refreshes or extra work while booking is blocked.

## 3. Render the time list and its loading state

Files: `src/lib/components/chrome/CsmBooking.svelte`, `CsmBookingSkeleton.svelte`, `CsmCalendarLayout.svelte`, `CsmCalendarDates.svelte`, and `csm-calendar.ts`.

- Replace the calendar/times split with a single list area and the existing time zone control. Share the rendered frame between the live picker and skeleton, using a purpose-specific time-list component if needed.
- Render all qualifying slots in chronological day groups. Show only groups with slots; do not require users to select a date before seeing times. Bound the list height and allow scrolling using the existing surface, border, spacing, and button conventions.
- Keep formatting by selected IANA time zone and preserve offset-qualified labels for repeated daylight-saving times. Use each slot's actual day in accessible Book labels rather than a selected-date state.
- Preserve native keyboard access, visible focus, selected-state announcements, and loading/status announcements. When a failed booking returns the user to the list, move focus to a relevant available time or the list's status/retry control instead of the removed date grid.
- Keep existing confirmation, uncertain-outcome recovery, setup admission, and automatic progression after booking. A presentation change must not allow another submission while one is unresolved.
- Replace the calendar skeleton with time-row placeholders and “Loading available times.” Update both modal and embedded setup loading consumers so no loading phase displays a calendar.
- Remove month/date cursor state, calendar keyboard navigation, date searching, calendar-only imports/icons, and the unused date-grid/layout components. Retain date/time formatting utilities that still have callers, moving them to a scheduling-named module and updating imports.

## 4. Maintain existing checks and verify the result

- Maintain affected fixtures and assertions without adding tests or expanding coverage. In the existing performance suite, replace month-specific fixture variation with meaningful mode/zone/replacement variation while preserving its coalescing, bounded caching, eviction, invalidation, and workspace ownership guarantees.
- Update existing provider fixtures to put intended available starts inside the new window. Preserve provider failure, scope, duration, and admission assertions rather than weakening them to pass.
- Adapt the existing component scenario that navigates months to exercise an available selection change, such as time zone, while preserving its original stale-read/lifetime guarantee.
- Run the required `npm run test:perf` after implementation. Run the affected existing booking component and backend recovery checks where necessary to verify the changed selection/focus and admission paths. Run `npm run check` and the production build; include Convex type checking using the repository's established tooling if the app checks do not cover it.
- Report the automated guarantees actually checked and any failures separately from unverified behavior. Existing unrelated working-tree changes must be preserved and distinguished from this implementation.
- Leave browser review to the user. Suggested review cases: normal and empty lists; time zone changes; a window crossing a month/year boundary; repeated daylight-saving time labels; a slot expiring while open; setup/support/replacement flows; matching skeletons; mobile scrolling and keyboard selection.
- If the existing tests do not establish the exact 48-hour boundary, idle refresh, or time zone edge behavior, report those gaps explicitly. Do not add new coverage without an explicit request.

## Completion criteria

- Every proposed start and newly accepted booking intent satisfies the same server-defined 48-hour rule.
- The picker and all its loading states show a list with no calendar or date navigation.
- Empty results never trigger a search beyond the window.
- Cache freshness, workspace isolation, booking confirmation, and recovery guarantees remain intact.
- Required checks have been run and their verified guarantees and remaining gaps are recorded.

## Completed implementation and validation

Availability and new-booking admission use the shared `now < start <= now + 48 hours` rule. The picker and loading states show a chronological time list grouped by date in the selected time zone, with no calendar grid or date navigation. Setup, support, and replacement flows retain booking confirmation/recovery, replay handling, authorization, workspace isolation, and cache/preload ownership.

The following checks passed during implementation validation, before the audit:

- `npm run test:perf` — 7 files, 41 tests passed.
- `npm run test:components -- tests/components/csm/csm-preload.test.ts` — 1 file, 8 tests passed.
- `npm run test:backend -- tests/backend/csm/recovery.test.ts` — 1 file, 3 tests passed.
- `npm run check` — Svelte reported 0 errors and 0 warnings; tools TypeScript passed.
- `npx tsc --project src/convex/tsconfig.json --noEmit` — passed.
- `node scripts/clean-vercel-output.mjs && npx vite build` — production build passed.
- `git diff --check` — tracked-diff whitespace check passed.

Existing assertions checked cache coalescing, bounded cache/lifetimes, provider parallelism, duration, scope isolation, replay/conflict preflight, blocked booking controls, and backend recovery. Affected fixtures and assertions were maintained without adding tests or expanding coverage. These results are prior implementation evidence; runtime checks were not rerun for the documentation correction.

Unverified: real-browser visual/keyboard interaction and mobile scrolling; live provider/network behavior; and dedicated regression scenarios for the exact 48-hour boundary, midnight/month/year rollover, repeated daylight-saving labels, selected-slot expiry, and hidden/visible idle refresh. Static review does not establish executed coverage of these scenarios. No deployment or live booking was performed. The audit artifacts track independent validation of the documentation correction.

This plan does not require a database migration or changes to the shared Cal event configuration. No provider writes, deployment, browser checks, or automated tests were performed during planning.
