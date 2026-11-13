# Cookies and activity

Visible buyer page openings and clause actions are recorded automatically. There
is no consent banner, Allow/Decline control or tracking-choice storage. Clause
activity is stored in Convex, never in cookies or a persistent client journal.
Browser recognition is approximate, not a person count. Verified members of the
contract's company are included, including while previewing the buyer view, with
You or Colleague tags relative to the person reading Recent activity. Signed-out
sellers cannot be distinguished from buyers.

`dinu_activity_browsers_v1` is a host-only HttpOnly SameSite=Lax cookie, Secure on
HTTPS. It contains at most eight hashed contract-link scopes and independently
random browser IDs, each with a fixed 30-day recognition lifetime. New openings
under an existing ID do not renew that cookie entry's lifetime. The cookie contains
no city, account identity or cross-contract browser ID. The permanent link is the
current contract scope; allowing multiple tokens per contract in future requires
an explicit scope change. With cookies blocked, one in-memory browser ID groups
only this page's opening and clauses. The old tracking-choice cookie is removed.

Client delivery waits for existing-session classification. Trusted intake independently
verifies the optional account token and derives the profile ID of same-company members
before allocating an opening, visitor number or quota owner. Unknown account
classification returns retryable HTTP 503
before any allocation or cookie write; supported session-cookie suffixes and
handshake artifacts never silently downgrade to anonymous. Unrelated-company accounts remain ordinary
buyers and can recover from transient verification failures within the existing
bounded same-ID retries, without reloading.

Activity delivery reuses the existing Clerk session's cached Convex credential,
fenced to its session and generation; intake forwards that bearer for verification
instead of minting a template token per event. Cookie-only intake remains a bounded
fallback. Pagehide uses an already-prepared unexpired credential or that fallback;
it never loads an account just to flush. Credentials and event history are not
persisted, and session changes discard queued work. Existing limits remain four
attempts, 120-second event age and 50 queued events.

`dinu_discussion_browser` is separate: a necessary host-only HttpOnly cookie created
on a discussion interaction, with a 180-day ownership lifetime. On first interaction
an existing valid `dinu_buyer_browser` value is adopted to preserve anonymous comment
ownership. The old cookie is never used by new activity. Public discussion reading
does not create this cookie. Account verification refreshes on requested discussion
actions while composers and operation identities remain mounted. Reconnection in
another tab preserves the current draft; Retry account refreshes verification.
Pending account operations and account-owned edits cannot silently change author.

Activity groups page openings into visits for the same browser and contract, or
the same verified company profile and contract. Internal profiles never share
visits with anonymous browsers or other profiles. Account changes discard queued
deliveries; the backend rejects attempts to change an opening's recorded identity.
An opening within 30 minutes of the last meaningful activity joins the existing
visit; a later opening records a return. Refreshes and extra tabs retain separate
delivery IDs without adding visible opening rows. Trusted scroll, pointer and key
events report activity at most once per minute while visible; clause clicks also
update the inactivity clock. Background polling, visibility changes and an idle
open tab never create returns or extend activity. Activity includes atomic
distinct-clause summaries and idempotency receipts. A visit retains the normalized
city from its first accepted opening's `x-vercel-ip-city` request header, forwarded
through secret server intake. Missing or invalid city is omitted; no raw IP address
is stored. Internal visits retain their verified profile ID for You/Colleague tags;
public request bodies cannot supply city or profile identity. Historical rows without
these fields remain unlabelled. Receipts witness distinct clause membership within a visit;
repeated events on one clause count it once.
Admission includes unchanged template summaries and released contract alternatives,
while unreleased contract-only alternatives remain inaccessible. A late
clause click cannot invent a return. Display times are server recording times, not
claims about exact action times. The panel shows up to two rows from the newest ten
unexpired visits; an old visit's late clause action does not move it into that
set. It refreshes every 30 seconds while open and prunes expired rows between
responses. No recorded activity does not prove no views.

Each visit and its page openings/children expire logically 30 days after the visit starts;
later clicks never extend that deadline. Trusted-clock seller reads and write
admission enforce expiry. Indexed daily cleanup physically retires expired rows in
bounded batches. Contract/company deletion removes all activity and limiter owners.
Current account-linked openings, receipts and historical clause memberships, as well
as legacy account-linked events/projections, are removed during account deletion even
when the company survives. Discussion content follows its separate ownership policy.

Delivery uses bounded memory only (50 queued events, four attempts, two-minute age),
stable IDs, 429 Retry-After handling and a small keepalive departure flush. Switching
links or losing eligibility cancels both the ordinary request and its retry wait. Offline
use, browser termination and quick closing remain best effort. Short-lived component
limits cover browser/link/company activity and separate discussion budgets. Origin
checks are browser CSRF checks, not proof of a human. No raw network address is stored
in activity. Managed Vercel edge protection and trusted network identity need explicit
configuration verification; no external configuration is implied by source changes.

Support videos show an app-hosted poster and Play button when the support dialog
opens. The poster preloads after primary content paints. Launcher intent or modal
opening may preconnect to the privacy-enhanced YouTube origin; the iframe and
playback load only after Play is activated. There is no outbound video link.
Closing the dialog or completing a booking destroys the iframe; reopening returns
to the poster.

ClerkJS is pinned centrally; browser and direct backend SDK telemetry are disabled.
Set `PUBLIC_CLERK_TELEMETRY_DISABLED=true` for svelte-clerk middleware in each deployed
application environment, including development. This does not disable authentication
network traffic. Help/widget dismissals are scoped to membership or buyer contract,
with storage-failure fallbacks.

HubSpot uses separate ten-minute callback-path cookies for base/Quotes. Only an exact
match selects a purpose. Callback responses never delete correlation cookies, avoiding
an older response erasing a newer attempt. Backend state stays single-use and fenced
to account, company, purpose and installation generation. Starting another attempt
does not cancel already-admitted work.

## Release and manual checks

No deployment or live-data operation is part of local implementation. Existing
historical opening rows are preserved; the grouping applies to new openings.
Inventory the
explicitly selected deployment before release; confirm schema/HTTP contracts and
[legacy retirement](link-activity-removal.md). Preserve anonymous discussion ownership
before retiring old cookie compatibility. Keep scheduled-function/deletion-phase
compatibility until all supported deployments have completed cleanup.

Manually check:

- Automatic opening/clause capture, cookie blocking, contract isolation and fixed
  browser-cookie lifetime. Repeat clicks count a clause once; late clicks never
  manufacture a return.
- You/Colleague attribution across company accounts, account switches, buyer preview,
  shared browsers and repeat tabs. Verify city on Vercel; missing location stays hidden.
- Slow/lost responses and 429 retries preserve IDs and stay bounded.
- Comment ownership survives browser activity expiry. Aged account sessions reconnect
  without losing drafts, pending operation IDs or original authorship.
- Server expiry hides activity before physical cleanup, and open panels expire rows.
  Deleted parents cannot be recreated by delayed requests.
- Support videos display the configured poster on modal open and load the player
  only after Play; closing stops playback, reopening returns to the poster,
  and booking/focus still work.
- Stale, canceled, wrong-purpose and reordered OAuth callbacks preserve newer state.
- Latest link copied still uses the approved single workspace status host.

Existing performance/type/build and targeted support/security checks protect their
established guarantees. They do not establish new delivery/retention or real-provider
behavior; there is no dedicated buyer-analytics test suite. No new tests or browser
automation were added.
