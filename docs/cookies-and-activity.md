# Cookies and activity

Visible buyer page openings and clause actions are recorded automatically. There
is no consent banner, Allow/Decline control or tracking-choice storage. Clause
activity is stored in Convex, never in cookies or a persistent client journal.
Browser recognition is approximate, not a person count; seller views can appear.

`dinu_activity_browsers_v1` is a host-only HttpOnly SameSite=Lax cookie, Secure on
HTTPS. It contains at most eight hashed contract-link scopes and independently
random browser IDs, each with a fixed 30-day recognition lifetime. New openings
under an existing ID do not renew that cookie entry's lifetime. No city, account
identity or cross-contract browser ID is collected. The permanent link is the
current contract scope; allowing multiple tokens per contract in future requires
an explicit scope change. With cookies blocked, one in-memory browser ID groups
only this page's opening and clauses. The old tracking-choice cookie is removed.

`dinu_discussion_browser` is separate: a necessary host-only HttpOnly cookie created
on a discussion interaction, with a 180-day ownership lifetime. On first interaction
an existing valid `dinu_buyer_browser` value is adopted to preserve anonymous comment
ownership. The old cookie is never used by new activity. Public discussion reading
does not create this cookie. Account verification refreshes on requested discussion
actions while composers and operation identities remain mounted. Reconnection in
another tab preserves the current draft; Retry account refreshes verification.
Pending account operations and account-owned edits cannot silently change author.

Activity is explicit openings plus atomic distinct-clause summaries and idempotency
receipts, without inactivity grouping, city or You/Colleague account labels. Receipts
also witness distinct clause membership; repeated events on one clause count it once.
Admission includes unchanged template summaries and released contract alternatives,
while unreleased contract-only alternatives remain inaccessible. A late
clause click cannot invent a return. Display times are server recording times, not
claims about exact action times. The panel shows up to two rows from the newest ten
unexpired openings; an old opening's late clause action does not move it into that
set. It refreshes every 30 seconds while open and prunes expired rows between
responses. No recorded activity does not prove no views.

Each opening and its children expire logically 30 days after server acceptance;
later clicks never extend that deadline. Trusted-clock seller reads and write
admission enforce expiry. Indexed daily cleanup physically retires expired rows in
bounded batches. Contract/company deletion removes all activity and limiter owners.
Legacy account-linked events/projections are removed during account deletion even
when the company survives. Discussion content follows its separate ownership policy.

Delivery uses bounded memory only (50 queued events, four attempts, two-minute age),
stable IDs, 429 Retry-After handling and a small keepalive departure flush. Switching
links or losing eligibility cancels both the ordinary request and its retry wait. Offline
use, browser termination and quick closing remain best effort. Short-lived component
limits cover browser/link/company activity and separate discussion budgets. Origin
checks are browser CSRF checks, not proof of a human. No raw network address is stored
in activity. Managed Vercel edge protection and trusted network identity need explicit
configuration verification; no external configuration is implied by source changes.

Support videos use a local placeholder until Load video. No Google preconnect,
thumbnail, iframe API or hidden iframe loads on hover, onboarding or modal open.
The privacy-enhanced iframe is destroyed on close and needs a fresh action on reopen.

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

No deployment or live-data operation is part of local implementation. Inventory the
explicitly selected deployment before release; confirm schema/HTTP contracts and
[legacy retirement](link-activity-removal.md). Preserve anonymous discussion ownership
before retiring old cookie compatibility. Keep scheduled-function/deletion-phase
compatibility until all supported deployments have completed cleanup.

Manually check:

- Automatic opening/clause capture, cookie blocking, contract isolation and fixed
  browser-cookie lifetime. Repeat clicks count a clause once; late clicks never
  manufacture a return.
- Slow/lost responses and 429 retries preserve IDs and stay bounded.
- Comment ownership survives browser activity expiry. Aged account sessions reconnect
  without losing drafts, pending operation IDs or original authorship.
- Server expiry hides activity before physical cleanup, and open panels expire rows.
  Deleted parents cannot be recreated by delayed requests.
- Support hover/onboarding/modal open sends no Google request before Load video;
  closing/reopening requires loading again, and booking/focus still work.
- Stale, canceled, wrong-purpose and reordered OAuth callbacks preserve newer state.
- Latest link copied still uses the approved single workspace status host.

Existing performance/type/build and targeted support/security checks protect their
established guarantees. They do not establish new delivery/retention or real-provider
behavior; there is no dedicated buyer-analytics test suite. No new tests or browser
automation were added.
