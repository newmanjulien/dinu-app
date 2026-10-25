# Private companies and rollout

Agreed supports many private companies and one company per account. Signup verifies
identity; it does not create or join a company. An account without membership sees
its invitations, can create a company, or can wait for a colleague's invitation.
There is no company search, discovery, domain matching, or automatic email-domain
join. Creating a company makes the creator its owner and an admin atomically.

Admins invite colleagues, remove members, and edit company settings. Every user selects their own Rep or Admin role in Settings; Admin grants these
permissions immediately without approval. Only the owner can transfer ownership. An owner must transfer
ownership before leaving, or before deleting their account while another live
colleague remains. The last live member can delete their account and company.
New profiles default to Rep. Invitations preserve the user’s chosen personal role. Existing playbook authoring
access is preserved; this change does not introduce an authoring capability policy.

Creating a company makes account setup ready immediately. Template readiness is
separate: a new company has no baseline until an admin uploads a DOCX or an operator
completes its initial seed import. Team and Settings work while contract creation and authoring show
the preparation screen. Companies never share another company's live template.

## Data model and boundaries

`profiles` hold Clerk identity, current email, name, personal avatar, and required
`role: rep | admin`. The email field is trimmed and lowercased on initialization; `by_email`
supports checking existing colleagues before issuing invitations.
`memberships` hold `profileId` and `companyId`; personal roles persist across company changes. Every join/create transaction
reads the unique `by_profileId` index before inserting. This makes concurrent joins
conflict and enforces one membership per profile. Convex indexes do not themselves
enforce uniqueness; operator writes must preserve it. `company.ownerProfileId`
points to a live membership in that company, except during ownerless recovery.
An owner can choose Rep, losing ordinary Admin capabilities while retaining ownership
actions. Transfers and recovery never modify either user’s personal role.
Admins can remove any colleague except the owner or themselves; self-removal uses
Leave company. The backend enforces these protections.
`settings.savePersonalRole({ role })` authenticates the caller and patches only that
profile. It accepts no target ID and requires no Admin permission. Team and operator
role-assignment endpoints are removed.

Live company-scoped business records require company IDs. Live blocks require `baselineId` and are indexed by baseline and order; playbook
items and template versions use `by_companyId`,
current template pointers use one indexed row per company, and contracts list/search
by company. Approval requests carry both the contract's company and the recipient
captured when the request was made. Updating the company's approval recipient does
not redirect an already queued request. Companies configure their approval recipient in Settings.

Public company operations require the caller's stable `membershipId`, resolve it
from authenticated identity, and compare it with the current membership before
accessing records. An old membership cannot operate in a newly joined company.
Contract snapshots and template children are accessed through their authorized
parent. Baseline blocks, immutable rule revisions, and version manifests also require
company scope so cleanup can drain company data in bounded batches. Parent company checks
happen before reading children or returning avatar
URLs. Snapshot HTTP requests carry the cache instance's membership ID; one backend
load validates that membership and reads the snapshot. Responses are authenticated
and `private, no-store`.
Every saved contract requires `templateVersionId`. The fresh reset retired the
per-contract snapshot tables and unused snapshot hashes; immutable version items
retain their original playbook identities even after live-item deletion.
Creation receipts include membership in their operation keys so retries cannot
create data in a different company after membership changes. Item and contract
receipts require an indexed company ID derived from authorized server context.
They survive individual target deletion to preserve retry idempotency and are
purged during explicit company deletion.

Snapshot caches are scoped to profile and membership. Contract draft journals are
scoped to deployment, Clerk user, membership, and contract. Authentication retries and personal role changes
preserve mounted editors and their cache instance; losing/changing membership
clears the previous membership's cache and journals and remounts the workspace.
Late calls from a replaced authentication client are rejected. Normal company exit
flushes pending editor changes and offers explicit discard after a failed flush.
Membership removal immediately denies subsequent backend operations and revokes
pending invitations for the removed colleague's email in the same transaction.

Contracts, immutable snapshots, receipts, and approval history belong to the
company and survive a colleague leaving or deleting only their account. Creator IDs
retain historical attribution. A creator who no longer has a live membership in
that company is displayed as a former colleague without exposing their profile.
Signed deletion markers immediately block the deleted identity. Cleanup removes
its membership, profile, and personal avatar, preserving company business data.
The last live member can explicitly consent to deleting both account and company;
company cleanup starts only after Clerk deletion is confirmed. Preparation,
dispatch and cleanup details are in [company deletion](company-deletion.md).

External Clerk deletion of an owner selects the oldest live remaining membership,
paging through at most 25 candidates per transaction. It updates ownership without
role preference or promotion. If no successor exists, the company becomes ownerless.
An operator can recover it through internal `companies:recoverOwner` with a verified
live membership in that exact company. This is not a public ownership-claim flow.

## Invitations

Invitations are application records, not Clerk Organizations or Clerk invitation
records. They target an exact normalized verified email. A Node action generates
32 random bytes and stores only their SHA-256 hash. Email links contain the raw
43-character token; it is never stored in the database or a scheduled job. Links
expire after seven days. Opening a link does not accept it: the signed-in user
must choose **Join company**. The authenticated inbox also allows explicit acceptance
without requiring the email link.

Resend rotates the token and delivery generation; revoke invalidates the current
generation. Acceptance checks the generation resolved from a link again inside
the membership-creation transaction, preventing an already opened old link from
accepting after resend. A user in another company must leave it first. Repeated
acceptance returns the existing membership only for the same accepted invitation
and company. Deleted or different verified identities cannot accept it. Invitations
to an existing company member are rejected before an email is sent. Pending
invitation pagination returns expiry timestamps; the client derives expiration
locally, so advancing time does not reset loaded pages.
The inbox uses a server-maintained expiry flag and an index that excludes expired
records before reading company and inviter details. Preparation schedules expiry
atomically; the expiry mutation checks the stored deadline so resends remain valid.
Subscriptions update when expiry runs, without device-clock checks or polling.
When deploying this change to an existing deployment, run
`companyInvitations:initializeExpiration` with `{"cursor":null}` once after the
push. It initializes pending records and schedules their remaining lifetime in
bounded, resumable batches. The optional expiry field permits existing records
until initialization completes; they are excluded from the inbox during that window.

Delivery uses the same Gmail SMTP configuration as approvals. Sending is inline
in one action per batch of up to 50 recipients, with a shared pool of at most five
SMTP connections and no automatic requeue. Each recipient keeps independent
delivery state and failures, and successful recipients are removed from the retry
input. Five workers take the next recipient as soon as a delivery finishes;
slow recipients do not hold up a whole group. Results retain input order, and
preparation starts only when a worker is available. Delivery retains the two-minute
resend cooldown.
A four-minute batch deadline closes the pool and destroys active SMTP sockets.
No further recipients start after that deadline; confirmed deliveries retain their
success, and unstarted recipients return a retryable error. Connection setup has
a separate 30-second deadline, including DNS and TLS negotiation.
Preparation atomically schedules a generation-checked timeout after two minutes.
It marks interrupted delivery as failed; a confirmed send is preserved, and a late
confirmation can still mark the same generation as sent.
Unconfirmed delivery requires explicit resend; there is no automatic SMTP retry.
Resend can deliver an additional email, and the previous link becomes unusable.
Do not log raw tokens or include invitation URLs in analytics. The invitation
component supplies a `no-referrer` policy.

## Fresh development reset

The canonical schema requires baseline/revision links, contract creators and review
maps, and structured numbering/reference patterns. Existing data is intentionally
discarded before deployment; no backfill or transitional schema is needed. This
procedure describes a development/local reset, not an action performed by the code.

1. Identify the exact Convex target from `.env.local`, process overrides, deployment
   credentials, and the frontend URL without logging secrets. Confirm the matching
   Clerk issuer. Do not infer a target from historical deployment notes.
2. Run `npm run seed:verify`. The retained seed contains 113 contract blocks and
   56 playbook items (62 triggers, 26 concessions, 66 changes).
3. Stop application writes and deletion webhooks, pause crons, and cancel or drain
   queued upload cleanup, company deletion, invitation, and approval jobs. Keep
   incoming requests stopped until the empty database and final schema are ready.
4. Clear every Convex application table and stored file, including physical tables
   omitted from the current schema. Verify all application data and storage are
   empty. Schema removal alone does not delete a physical table. No Clerk account
   deletion is required for this database reset.
5. Deploy the strict backend and matching frontend. Remove temporary reset helpers
   if any were used. Browser caches and draft checkpoints use new format namespaces
   and cannot restore incompatible records.
6. Sign in or sign up through normal onboarding with verified email and create the
   company. Existing Clerk users can initialize their missing application profile.
   Obtain the actual Convex company ID; do not fabricate authentication metadata or
   ownership records.
7. Run the scoped seed and read-only audit below. Preserve fingerprint, committed
   prefix, bounded batching, and publication checks. Resume any interrupted import
   using the same command; never import the business JSONL directly into tables.
8. Restore recurring work and access. Verify the published template, create/render
   a contract, and check an admin Save/Delete. Record the target, company ID, and
   check results.

The seed restores the supplied baseline and playbook. Saved contracts, invitations,
approval history, uploaded files, and later content edits are cleared. No database
wipe, deployment, or live seed run is performed by local verification.

## Initial company template import

For a fresh development/local deployment, configure Clerk, sign up, create a company,
and copy its ID from the Convex dashboard. With matching `CONVEX_DEPLOYMENT` and
`PUBLIC_CONVEX_URL`, run:

```sh
npm run convex:seed -- --company-id COMPANY_ID
npm run db:audit -- --company-id COMPANY_ID --seed
```

The seed script rejects production, mismatched targets, missing company IDs,
existing content from a different import, and altered committed prefixes. It uses
internal `companyTemplateImport:begin`, `append`, and `finish`, with a content SHA-256
fingerprint and committed counts. Each append atomically inserts at most four
records; the CLI further limits batches to 64 KB. Retrying the same seed resumes
at the committed counts. Finishing validates and publishes an immutable template
atomically before releasing maintenance. Interrupted imports remain in maintenance.
An unchanged completed import is idempotent; edited or intentionally deleted data
is never restored by reseeding.

`db:audit` is read-only, bounded, company-scoped, and uses the configured exact
target. `--seed` requires an exact business-data comparison. It can read a configured
production target; it cannot write or publish templates. It does not certify
membership/authorization or snapshot relationship integrity.
Audit and seed verification scan blocks and items concurrently through the installed
Convex CLI, without invoking `npx` for each page. Seed mutations remain sequential.

Production initial imports require an explicitly authorized, rehearsed operator
workflow using the same scoped internal API with validated company-specific data,
fingerprint, prefix checks, and finish validation. The development seed command
has no production override. Do not load the unscoped JSONL fixtures with direct
`convex import`; each company must have its own scope and template pointer.

## Manual release checks

Use disposable nonproduction accounts in two companies and one unaffiliated
account. Check verified signup and waiting, create versus invite, wrong-email links,
expired/revoked/rotated links, concurrent acceptance/create, explicit acceptance,
and being invited while already in a company. Confirm a company is never listed or
suggested solely from an email domain.

Call contract, template, playbook, colleague, avatar, approval, and invitation APIs
with another company's IDs and stale membership IDs. Confirm refusal and no profile
or snapshot leakage. Remove a colleague while they have an editor and upload open;
confirm revocation, cache/journal cleanup, and retention of their company contracts.
Select Admin as a Rep and verify immediate UI and backend access; switch back and
verify denial. Confirm users cannot set another profile’s role. Check owner-to-Rep,
role-preserving ownership transfer, owner/self removal protections, owner deletion
with and without live colleagues, external deletion, successor paging, and internal
ownerless recovery. Repeat import after
interrupting batches and confirm counts and original records remain stable.

Check authentication retry, logout save/cancel/discard, leaving with pending saves,
refresh recovery, and joining a different company without restoring old drafts.
Exercise keyboard focus and mobile layouts for onboarding and team actions. Verify
actual invitation delivery/resend and approval delivery with two distinct company
recipients, including recipient changes while a request is queued.

The existing performance suite checks saving/conflicts/retries, creation/publication,
scheduling, and cache invariants. Type checks and production build check integration.
The offline seed verifier checks the original business data, its preservation through
playbook saves and publication, rendered text, and contract compositor parity.
They do not certify the live reset, Clerk/SMTP configuration, browser UX, or
cross-company authorization scenarios above. No new tests were added for this task.
