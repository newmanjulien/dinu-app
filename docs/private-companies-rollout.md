# Private companies and rollout

**Current domain model, 2026-10-30.** [Current architecture](backend-redesign/architecture.md) is the model entry point; [Phase 18](backend-redesign/phase-18-activation.md) owns all target/reset/deploy/acceptance actions. Earlier development resets do not establish that the redesigned backend is deployed.

Dinu supports many private companies and one company per account. Signup verifies
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
Every saved contract requires `templateVersionId`. The current local model removes
per-contract snapshot tables and unused snapshot hashes; Phase 18 must clear any
remaining physical legacy tables. Immutable version items
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
The canonical expiry flag is required; the pre-customer reset/bootstrap establishes
that shape without an initialization function or transitional reader.

Delivery uses the same Loops transactional adapter as approvals and completed reviews.
Three repo-owned native LMX templates use typed scalar notification data;
see [email delivery](email-delivery.md) for secure configuration and activation.
Sending is inline in one action per batch of up to 50 recipients, with five workers
and no automatic resend. Each recipient keeps independent delivery state/results;
workers take the next recipient as soon as a delivery finishes, and results retain
input order. Preparation starts only when a worker is available. The two-minute
resend checks remain.

A four-minute batch deadline aborts active HTTP work and prevents further recipients
from starting. Confirmed results remain; unstarted recipients return their existing
retryable error. Provider requests have a 60-second timeout. Native quota reserves
capacity before a fresh dispatch claim. Recovery waits beyond possible inline
execution, using the deadline plus seven-minute grace; the resend cooldown is not
an execution lease. Unconfirmed dispatch remains uncertain and requires explicit
resend, which can deliver an additional email and rotates the previous link.

Do not log raw tokens or include invitation URLs in analytics. The invitation
component supplies a `no-referrer` policy.

## Fresh development reset

Use the [current Phase 18 procedure](backend-redesign/phase-18-activation.md), with separate inventory/archive, reset/deploy/bootstrap, native/browser and Loops checkpoints. It supersedes the staged-import and older reset recipes. Confirm the exact target, preserve a storage-inclusive archive and restoration evidence, inspect removed physical tables and native jobs, and prepare the actual reset mechanism before authorization. Schema deployment does not clear old tables, jobs, files or sweep frontiers. Preserve existing Clerk accounts and pending browser intent independently.

The reset removes agreed disposable application records and uploaded files, including saved contracts and later edits, while preserving independent offline archives and the approved canonical dataset. No live reset/deployment/seed run has occurred during this redesign.

## Initial company template import

After the authorized backend activation, use normal verified onboarding and obtain the real company ID. Securely configure its exact development/local deployment admin key together with matching `CONVEX_DEPLOYMENT` and `PUBLIC_CONVEX_URL`, then run:

```sh
npm run convex:seed -- --company-id COMPANY_ID
npm run db:audit -- --company-id COMPANY_ID --seed
```

The seeder calls internal `operator:bootstrap` once with the complete canonical blocks/items. Bootstrap uses ordinary validated baseline/history writers and commits the baseline, live rules, immutable revisions, complete first version and current pointer atomically. Exact replay returns the committed state without writes; changed/incomplete content refuses without overwrite or restoration. An interrupted HTTP response does not establish rollback; inspect or repeat the exact bootstrap after resolving the outcome. There is no begin/append/finish import, committed prefix, maintenance pointer or CLI batch layout.

The runner uses the native internal function HTTP protocol/public value codec and allows only its explicitly scoped bootstrap/read functions. It rejects mismatched targets, missing company/key scope and production writes. The read-only audit permits correctly configured production reads, validates the current playbook and independently compares live/published business content. `--seed` additionally compares the approved canonical dataset: **112 blocks, 56 rules/highlights, 26 concessions and 34 affected locations**. It does not certify every public authorization/storage/scheduler/native-limit path. Production bootstrap requires its own reviewed invocation and exact-target authorization; do not weaken the development seeder's guard.

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
ownerless recovery. Repeat the exact atomic bootstrap after a lost response and confirm readback and no-write replay.

Check authentication retry, logout save/cancel/discard, leaving with pending saves,
refresh recovery, and joining a different company without restoring old drafts.
Exercise keyboard focus and mobile layouts for onboarding and team actions. Verify
actual invitation delivery/resend and approval delivery with two distinct company
recipients, including recipient changes while a request is queued.

The existing performance suite checks saving/conflicts/retries, creation/publication,
scheduling, and cache invariants. Type checks and production build check integration.
The offline seed verifier checks the original business data, its preservation through
playbook saves and publication, rendered text, and contract compositor parity.
They do not certify the live reset, Clerk/Loops configuration, browser interactions, or
cross-company authorization scenarios above. No new tests were added for this task.
