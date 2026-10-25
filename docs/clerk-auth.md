# Clerk authentication and rollout

The custom `/login`, `/join`, Settings, and deletion components adapt Overbase
revision `61c97882e42a2b3cbb4fccbb7448a954e147367d`. Signup ends after email
verification. Anyone can sign up; company membership requires explicit company
creation or acceptance of a colleague's invitation. Companies are private, with
no discovery or email-domain matching. Accounts belong to one company at a time.
Clerk owns identity and verified sign-in email. Convex owns profiles, memberships,
roles, company settings, and invitation records. Settings never updates another
user's profile or Clerk's name. See [the company schema and rollout
runbook](private-companies-rollout.md) before updating an existing deployment.

## Development configuration

Create an Agreed **development** application in Clerk. Enable email verification
codes for signup and sign-in, open signup, self-deletion, and reverification for
sensitive actions. Disable required passwords, names, and legal acceptance so the
custom signup can finish with an email and code. Clerk Organizations are
unnecessary; Agreed supplies its own company onboarding and invitation acceptance. Configure `/login` and `/join` as the custom auth routes, `/` as the
fallback destination, and the frontend development origin as an allowed redirect.

Copy `.env.example` to `.env.local`, keeping the existing Convex deployment values.
Set `PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` from this application.
Only the publishable key belongs in browser code.

Create Clerk's **convex** JWT template. Preserve its Convex defaults, including
`aud: "convex"`, and include these identity claims:

```json
{
	"aud": "convex",
	"email": "{{user.primary_email_address}}",
	"email_verified": "{{user.email_verified}}",
	"name": "{{user.full_name}}"
}
```

Clerk resolves the verification shortcode to a boolean. Agreed requires
`emailVerified === true`; an absent or false claim blocks profile initialization
and business operations. The issuer is the template's `iss` URL, including `https://`.

Configure the matching **Convex development deployment** with these backend values
before pushing the authentication config:

| Variable                       | Value                                            |
| ------------------------------ | ------------------------------------------------ |
| `CLERK_JWT_ISSUER_DOMAIN`      | Clerk's JWT issuer URL                           |
| `CLERK_SECRET_KEY`             | The same development application's server secret |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Signing secret of the webhook below              |
| `APP_URL`                      | Frontend origin, e.g. `http://localhost:5173`    |

Use the Convex dashboard to set secrets without including them in command history.
`APP_URL` controls approval and company invitation email links. Secrets are never public environment
variables. Each environment must use its own matching Clerk application and keys.

Add a Clerk webhook for **user.deleted** at
`https://<deployment>.convex.site/clerk/webhook`. Use the `.site` HTTP endpoint,
not `.cloud`. Copy its signing secret to the matching Convex deployment. A valid
delivery is acknowledged only after the permanent deletion marker commits.

Run `npx convex dev` against the intended development deployment, then `npm run dev`.
The browser uses Convex's authenticated Svelte integration with Clerk's `convex`
token. Each Clerk session gets a fresh Convex client; local snapshot caches are
scoped to profile and membership and cleared on logout, deletion, account changes,
or membership changes. Server
snapshot reads forward an authenticated token and return `private, no-store`.

## Preparing an account for a user

In the matching Clerk application's Users page, create the user with their real
email address and no password. The primary email must be verified; Agreed requires
the `email_verified` JWT claim above.

Choose **Impersonate user** from the user's three-dot menu. Clerk opens Agreed's
configured `/login` route with a one-time `__clerk_ticket`. The login flow consumes
that sign-in ticket, activates the impersonated session, and opens normal onboarding
or the existing workspace without asking for an email code. Clerk continues to
control who can issue impersonation links; Agreed only consumes the issued ticket.
The `/join` route handles Clerk signup tickets separately.

Complete onboarding and Settings as the user. Creating a company makes them its
owner and Admin. To join an existing company, invite their email from that company's
Team page, then open and accept the invitation while impersonating them. Sign out
when finished. The user can later sign in with their normal email code and use the
prepared account. If the link expires or has already been used, open a fresh
impersonation link from Clerk.

See [Clerk's impersonation guide](https://clerk.com/docs/guides/users/impersonation).

## Roles and permissions

`src/convex/permissions.ts` defines personal roles and capabilities. Profiles store
required `rep` / `admin` roles; memberships store only profile and company identity.
Any authenticated user can select either role for themselves in Settings, without
approval. `settings.savePersonalRole({ role })` resolves the caller from identity,
accepts no target profile ID, and returns `null`. There is no operator or team role
assignment API.

Admin grants company name, approval recipient, company avatar, invitation, and
member removal permissions. Admins can remove any colleague except the owner or
themselves; self-removal uses Leave company. Company ownership is independent of
role. Only the owner transfers ownership, including when they choose Rep. Owners
must transfer before leaving, or before deleting their account when another live
colleague remains. The last live member can delete their account and company.
Transfers and owner
recovery never change personal roles. Playbook and contract authoring retain their
existing access.

Every public company operation supplies its stable `membershipId`. Convex resolves
membership from authenticated identity and rejects stale or foreign IDs. Company
avatar uploads authorize before storage and again in the committing mutation;
switching to Rep during upload prevents commit and rejected uploads are cleaned up.
The viewer reacts to profile role changes. Session, editor, cache, and draft
identity remain profile plus membership, so role changes preserve mounted drafts.

New profiles default to Rep. Creating a company atomically sets its creator to
Admin and owner. Accepting an invitation preserves the chosen personal role, which
also persists when leaving or joining a company.

Company invitations have a dedicated `/invitation` flow. A valid random link
shows the company and fixed invited email before authentication. Continue sends
an email code; Clerk signs in an existing account or automatically creates an
account using the verified email. Invitees then explicitly choose Join [Company]
and enter the workspace without company setup. Account switching returns directly
to the invitation. The anonymous preview exposes no invitation ID or acceptance
generation; authenticated resolution and acceptance require the exact verified email.
Verified signed-in requests skip the anonymous preview. Expiry is evaluated by the
backend after its cached database lookup; the anonymous flow uses the remaining
duration rather than comparing expiry against the recipient's device clock.
Resend rotates the hashed token and delivery generation; revoke invalidates the link.
Old Clerk invitations do not create memberships and must be reissued through the
company team page. Configure Gmail SMTP backend credentials for invitations and
approvals, and set each company's approval recipient in Settings. See the runbook
for expiry, cooldown, and queued-recipient behavior.

## Session transitions and contract drafts

While an email code is being sent and entered, sign-in preloads the destination's
route modules and opens an unused Convex connection. Document destinations also
preload the document host. No account query runs on that connection until the
verified session owns it. Failed code requests, failed invitation acceptance,
changing email, or leaving sign-in without a session close the unused connection;
a session takes ownership once, and retries create a fresh client. Code preloading
does not run protected server loads. The authenticated account host preloads
independently of the workspace. Workspace destinations preload Workspace, Home
destinations also preload Home, and entry destinations avoid those imports.
The live viewer decides account readiness; the workspace boundary separately
requires membership. See [Account entry and workspace routes](account-routes.md).

Once Clerk accepts the code, the Convex token request overlaps navigation. Clients
enable Convex 1.46's experimental `initialAuthTokenReuse` option to avoid an
immediate second token fetch and the resulting re-execution of authenticated
queries. Convex validates the initial token, refreshes before expiry, and forces
a fresh token on rejection. Explicit recovery also bypasses Clerk's token cache.
Check this option when upgrading Convex.

Login and destination startup share a centered, neutral loading wheel. Recovery
text and controls appear for failed or delayed startup. Account and membership
readiness still determine whether Home or company setup appears. Home's header
and controls do not wait for the first contract-list response; that list owns its
loading and error states, including a 15-second read deadline. Company setup
appears without waiting for invitations, and invitations update within the chosen
screen rather than switching it.

In development, or with `PUBLIC_CONTRACT_PERF=1`, `window.__accountStartup`
records code submission, auth acceptance, navigation, backend authentication,
account readiness, admission (`usable`), and the first dashboard result paint.
Compare timestamps within the same `attemptId` to separate verification,
navigation, connection, account preparation, and list loading. These markers
support browser measurements; the existing automated performance suite does
not measure real email-code login latency or visual continuity.

A root session controller persists across entry and workspace routes and
coordinates connection, account readiness, logout, and account loss. The lazy
authenticated account host owns the transport and viewer. Temporary token or
profile errors keep its admitted subtree mounted with interaction blocked. A rejected connection shows retry
and logout actions; after ten seconds, a pending connection or preparation also
offers these actions. Retrying requests a fresh Clerk token and replaces the
Convex client while preserving mounted editors. Ordinary Clerk resource refreshes
do not reset the client or snapshot caches.

The session's stable client context scopes imperative queries, mutations, and
actions to the client that submitted them. Replacing or destroying that client
rejects outstanding calls with `ConnectionInterruptedError` before closing it.
Late SDK results are consumed without reaching the old callers; busy flags and
navigation/logout waiters can finish even when the SDK leaves its requests pending.
Subscriptions remain reactive and attach to the replacement client.
Identity changes also advance the session generation so a result delivered just
before teardown cannot update the next account's state.

Interruption does not cancel a server write. Contract saves replay their immutable
request after reconciling fresh metadata. Contract creation retries keep the original
operation ID and company name; a confirmed contract remains available if loading
its snapshot fails. A definitively rejected first creation releases its arguments
so a corrected name can be submitted. Once an attempt is uncertain, retries keep
its original arguments until creation is confirmed. Approval, Home, Settings, and invitation writes are not
automatically replayed. Their existing actions allow explicit retry after recovery.
Team subscribes to its company invitations and stops interrupted send batches
with unconfirmed addresses retained. Approval eligibility uses fresh subscribed status.

Logout freezes editing and waits for pending contract saves before calling Clerk.
If saving fails or remains pending, the user can retry, cancel logout, or explicitly
discard local changes and log out. Canceling keeps the editor and its draft; a
request already handed to Convex can still commit. Playbook authoring participates
in the same guard: an in-flight save must finish, and unsaved manual edits require
canceling logout to save them or explicitly discarding them. Closing a session
bypasses editor navigation guards so they cannot block the login redirect.

Contract selection drafts have a separate operation journal in `sessionStorage`,
scoped to deployment, Clerk user, membership, and contract. It records intended selections,
the confirmed base revision, any immutable pending request, and conflict status
before sending. Confirmed snapshot caches never contain unsaved intent. Drafts
survive refresh and unexpected session loss in the same tab; only the same signed-in
user with the same live membership can restore them. The browser discards them when the tab closes. If storage
is unavailable, an explicit warning says changes are retained only in memory.
Playbook authoring drafts remain in the mounted editor and do not use this journal.
Membership loss clears the previous membership’s journal and cache, then remounts
the workspace. Leaving a company flushes pending editor changes before removing
membership, with explicit discard available after a failed flush.

Recovery waits for fresh authenticated server metadata. An acknowledged operation
is not replayed; an unchanged base can retry the original request; a changed base
retains the local selections and requires **Use latest version** or **Apply my
selections**. Conflicts remain explicit through refresh. Successful saves and
explicit discards remove the checkpoint. Successful account deletion clears all
of that user's drafts and prevents late callbacks from recreating them.

Matching selections alone never acknowledge an outstanding operation. The journal
keeps the submitted choices separate from the latest local choices: if a selection
is removed while its earlier save is pending, recovery resolves that earlier save
before saving the removal. A checkpoint remains until the operation is resolved and
the latest intent is confirmed, or the user explicitly resolves a conflict.
“Use latest version” pauses follow-up saving while waiting for an active request.
If its outcome is still uncertain, it retains the draft and reports failure.

## Fresh development reset

Clear incompatible Convex records and stored files before deploying the canonical
schema. Stop writes, deletion webhooks, and queued/recurring work first. Clerk
accounts can remain: normal onboarding initializes a missing application profile
and lets the user create a company. Then seed the actual company ID through the
scoped importer. Follow [the reset procedure](private-companies-rollout.md#fresh-development-reset).

## Deletion and recovery

An owner with another live colleague must transfer ownership before account
deletion. Other members use **delete my account** and retain company data. The last
live member uses **delete my account and company** to delete both. Invitations and
members already marked deleted do not count as live colleagues. The server checks
current identity, membership, eligibility, and the exact phrase before every Clerk
deletion attempt, including retries after reverification.

Combined deletion first prepares a durable request, then dispatches that exact
request before the existing client `user.delete()` call. A preparation can be
cancelled and expires after 15 minutes. Dispatch preserves consent across Clerk
errors, reverification, modal replacement, and retries; it cannot be cancelled or
expired. Neither preparation nor dispatch deletes company data. Only a verified
deletion webhook or a complete, successful Clerk lookup establishing the account's
absence starts cleanup. Account-only deletion creates no company request.

Successful deletion clears local state and redirects directly to `/login`
from the persistent auth bridge, even if session loss has already removed the
deletion modal. It does not wait for a redundant sign-out request or Convex cleanup.
Protected routes also redirect when Clerk finishes loading without a session.

The verified webhook records an issuer-qualified deletion marker and queues
cleanup. That marker immediately denies the deleted identity. Cleanup removes its
membership, personal avatar, and profile. Account-only cleanup retains the company, contracts,
snapshots, approval records, and receipts. Former creators display as former
colleagues without disclosing their profile. Company contracts remain accessible
to current colleagues and queued approvals retain their company recipient.
Confirmed combined deletion also drains company business records, snapshot children,
creation receipts, memberships, and the company avatar before completing a permanent
company deletion marker. See [company deletion](company-deletion.md) for the lifecycle,
cleanup order, recovery, and reset procedure.

External owner deletion transfers ownership to the oldest live remaining membership
using bounded pagination, without role preference or changing the successor’s role. If no successor
exists, the company becomes ownerless and requires internal operator recovery;
there is no public company claim flow. Details are in the company runbook.

Every 15 minutes reconciliation checks registered profiles and dispatched company
requests against Clerk with one batch lookup per 25-record page and resumes
unfinished jobs. The company request scan works after the profile is gone. Only an account
missing from a complete, successful batch response records a deletion; network
errors and incomplete responses retain the account. Each deletion marker tracks
one cleanup job chain; repeated webhooks reuse an active chain, and stale jobs
do no work. Recovery isolates individual failures and advances through all pages.
Inspect `deletedUsers.complete`, `companyDeletions.status`, and scheduled-function
failures to diagnose incomplete cleanup. Fix the cause and run the internal
`accountDeletion.resume` and `companyDeletion.resume` mutations as appropriate;
keep completed deletion markers permanently.

## Verification before rollout

`npm run verify` runs the existing performance suite, Svelte/type checks, and
production build. Existing fixtures carry authenticated identities. Their saving,
conflict, retry, creation, immutable publication, scheduling, and cache assertions
remain in place; no new test suite was added.

Live configuration and browser checks need development Clerk keys and SMTP setup.
Use accounts in two companies plus an unaffiliated account. Verify email codes,
signup/login, explicit invitation acceptance, wrong-email and rotated/revoked links,
create/wait onboarding, role and ownership changes, company/personal avatar saves,
and owner deletion eligibility. Confirm companies never appear from domain matching.

Call company APIs with another company's record IDs and stale membership IDs and
confirm rejection. Remove a colleague with a contract and upload open; confirm
immediate access loss, draft/cache cleanup, rejected upload cleanup, retained
company contracts, and former-colleague attribution. Check anonymously called
Convex operations and the snapshot HTTP endpoint are rejected.

On disposable development data, interrupt and resume the company seed import.
Delete an owner externally, redeliver signed webhooks, and simulate a missed webhook
through reconciliation. Check live successor selection and ownerless recovery.
Compare scoped counts, snapshot links, historical creator IDs and selections.
Confirm failed or incomplete Clerk lookups never start deletion, and an uncertain
client deletion result preserves dispatched consent. Exercise the deletion races
listed in [the deletion runbook](company-deletion.md#manual-verification).
The local suite/build does not
certify these live authorization and reset checks.

Exercise session transitions: interrupt selection saves, retry authentication with
an editor mounted, and use logout save/cancel/discard. Refresh with an unacknowledged
save and verify committed and uncommitted recovery. Concurrently edit the contract
from another session and confirm recovery never silently overwrites it. Switch
accounts and companies and confirm old drafts never restore across those boundaries.
Repeat during creation and authoring to check navigation guards and late callbacks.
Finally, complete deletion while its modal unmounts and confirm direct navigation
to `/login` without waiting for webhook cleanup or an extra sign-out call.

Review mobile layouts, keyboard focus, Escape, and focus restoration for onboarding,
settings, team confirmations, and modals. Verify actual invitation and approval
SMTP delivery, including distinct recipients for two companies and a recipient
change while an approval is queued. These remain manual rollout gates; no new
browser or backend test suite was added.
