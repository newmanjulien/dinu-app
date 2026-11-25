# Account and company deletion

Current architecture: [data model](data-model.md). Release mechanics: [production releases](deployment.md).

This runbook describes account and company cleanup. Native, provider and browser
behavior require separate verification. Accounts normally leave through the app, and most companies remain active after individual departures.

## Consent and eligibility

Account deletion uses Clerk session reverification before any database state changes, then executes Clerk user deletion server-side from Convex (`accountDeletionActions.execute`). The server determines the deletion mode from authenticated identity, current membership and live colleagues:

- An owner with another live colleague transfers ownership first.
- Other members delete their account with the confirmation phrase, keeping company business data.
- The last live member confirms both account and company deletion, regardless of personal role.
- Pending invitations and profiles with verified deletion tombstones are not live colleagues. Eligibility stops at the first live colleague and rejects conservatively after 100 memberships awaiting cleanup.

Company consent has three states:

| State    | Meaning                                                                                                  | Expiry/cancellation                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Deleting | Server action validated fresh reverification, phrase and eligibility and is calling Clerk `deleteUser`   | Released immediately on definitive Clerk refusal; auto-reconciled after 60 seconds (or via Settings Retry/Cancel) if unsure |
| Cleaning | Server action, signed webhook, or reconciliation confirmed account deletion                              | Company stays unavailable while bounded cleanup progresses                                                                  |
| Complete | Company scope and final company/avatar reference were removed                                            | Permanent tombstone                                                                                                         |

The schema pairs `deleting` holds with the initial phase, `cleaning` with the complete phase list and `complete` with the final company phase. Job IDs remain optional during allocation/completion; no extra record field is needed.

Before recording any hold, the Convex action verifies a fresh default Clerk session JWT (`verifyToken`), rejects impersonated sessions (`act`), and enforces Clerk’s strict `fva` freshness window (< 10 minutes). While the user types the confirmation phrase or completes email/passkey/password verification, no database hold exists and company activity is never paused. Account-only deletion creates no company hold.

When `clerkClient.users.deleteUser` succeeds (or returns 404), the action immediately commits `deletedUsers` and advances `companyDeletions` to `cleaning`. A definitive 4xx refusal immediately removes the `deleting` hold. On an ambiguous failure (timeout/5xx/429), the hold stays briefly paused while a 60-second `clerk.resolveDeleting` job (and 15-minute reconciliation) checks Clerk — advancing to `cleaning` if the user is gone or automatically releasing the hold if the user still exists. In the meantime, Settings surfaces explicit Retry and Cancel actions backed by live Clerk status checks.

## Retention and ownership

Verified deletion records a permanent issuer-qualified account marker and confirms dispatched company consent in the same mutation, including when no profile remains. Repeated webhooks are idempotent.

Account cleanup normally removes the profile/membership and safely releases the personal avatar; unresolved sole-owner recovery retains them as described below. Membership removal queues bounded cleanup of buyer-link bar showing records. It retains company contracts, source/playbook template versions, independent output/provider evidence, email delivery events and invitations. Flat `operationReceipts` expire after 24 hours via daily cron (`operationReceipts.pruneExpired`); receipt expiry never erases business history or unresolved outcomes. Historical actor/uploader/creator IDs remain business history; live access/recipient resolution still checks current membership and deletion markers. The directory displays the company name when a departed creator has no live profile.

An externally deleted owner transfers to the oldest live remaining member without changing the successor's role. A bounded 25-membership successor page persists its cursor before continuing; the profile remains until ownership is resolved. If no live successor exists, cleanup records `deletedUsers.recoveryCompanyId`, clears its cleanup job and retains the deleted owner's profile, membership, avatar and `company.ownerProfileId` anchor. The deletion marker continues to deny that identity access. The company does not become ownerless. Dispatched company consent instead authorizes company cleanup.

An operator resolves this hold through internal `companies:recoverOwner` with the company ID and a verified live replacement profile. The replacement must have no membership or already belong to that company; the mutation creates or promotes its membership to Admin and assigns ownership. It then removes the retained prior membership/profile, safely releases the avatar and completes the matching account marker. This is not a public ownership-claim flow. The authority is [account cleanup](../src/convex/accountDeletion.ts) and [owner recovery](../src/convex/companies.ts).

Company cleanup uses the [single ordered 14-phase list](../src/convex/deletionValidators.ts): `invitations`, `hubspot` (via `retireCompanyHubSpot`), `deliveries`, `contractCleanups`, `operationReceipts`, `exports`, `buyerActivity` (openings, receipts, counters, and `buyerActivityQuotaKeys`), `buyerLinks` (links, `buyerLinkBarShowings`, and `buyerLinkShowingCleanups`), `discussions` (`discussionQuotaKeys`, `discussionMessages`, and `discussionThreads`), `contracts` (`savedContracts`, `contractHubspotAssociations`, `contractBuyerRefreshes`, and `contractDirectory`), `templateData` (source chunks, validation chunks, certificates, live items, item creation receipts, versions, `currentTemplate`, sources + retained originals, and revisions), `csmBookings` (webhook evidence, meeting preparations, setup appointments, booking attempts cancelling `sendJobId`/`watchdogJobId`/`recoveryJobId`, and erased initial guards), `memberships`, and finally `company`. The complete matrix maps every company-scoped table in `schema.ts`. Profiles, account tombstones and global sweep progress have separate owners.

Item-creation receipts retain their independent protocol. Shared template versions/revisions/source survive individual contract/item deletion. Company deletion purges its `operationReceipts` and business history but retains its completed tombstone. Legacy rolling-deploy fallback scans, `authoringMigrations`, and `contractCreationReceipts` are removed. Canonical current activity/discussion/output/provider owners remain in the bounded cleanup phases.

File release removes the owner's reference, then checks all five ownership families before deleting storage in the same mutation: template source originals (including company-owned pending uploads), profile avatars, company avatars, HubSpot exports and HubSpot quote pushes. A pending source owns its original file even after its uploader leaves. Another owner preserves the bytes. [Storage ownership](../src/convex/storageOwnership.ts) is the authoritative shared check for owner cleanup and the orphan sweep.

Interrupted unreferenced uploads/exports are recovered by the all-kind, exact 24-hour grace-protected sweep. It uses bounded 25-row/1 MiB metadata pages, a durable creation frontier/cursor/cutoff and stale-continuation fencing. Each file passes the same transactional ownership check before deletion; storage failure rolls back file and progress changes. A normal daily root resumes an interrupted interval.

## Bounded cleanup and recovery

Company/contract/expired-template source child drains share a 100-primary-row budget. Native remaining metrics reserve 4,000,000 read/write bytes, 64 queries/read/write documents, one continuation and 1,024 scheduled argument bytes. They leave room for cancellation, reference release, parent deletion and marker progress. These are reserves, not new customer limits.

Account/company/contract workers store their current job/generation. Resumption keeps pending/in-progress jobs, rearms missing/failed/cancelled/finished jobs and advances the generation. Stale generations are no-ops. Unexpected mutation failure rolls back the batch and leaves its durable owner discoverable. Company deletion cancels tracked contract/send/recovery/invitation-expiry/CSM-booking work; an already dispatched external email cannot be recalled.

Template upload expiry uses its own ID/state/deadline and remaining indexed chunk prefix. An active template source or a missing row makes a delayed callback a no-op. Each yielding invocation schedules one continuation; duplicate expiry callbacks can perform additional bounded work. It does not maintain an exclusive generation/job marker. Thirty-minute discovery independently pages expired pending/deleting states, reaching later uploads even if earlier workers fail.

Quarter-hour reconciliation invokes one bounded local recovery mutation before provider configuration/lookup. Indexed first-record probes schedule only nonempty account/company/contract/membership-showing/disposal/consent/unfinished-email/dispatched-company families; errors are isolated and workers page independently. The exact expired-preparation range excludes fresh consent. Delivery resumption restores the existing recovery rule: missing jobs do not establish non-delivery, claimed attempts become uncertain, uncertain decisions never automatically resend, and uncertain approvals only become eligible for an explicit retry after the existing ten-minute cooldown. Terminal/exhausted/retired attempts remain untouched.

Clerk profile/dispatched-company discovery targets 100 native rows with explicit 100-row/2 MiB caps and preserves native pagination metadata. Filter the configured issuer, deduplicate IDs, then split every provider request at 100 IDs independently of page length; its limit equals its ID count. Only a complete duplicate-free/requested-ID-only response whose returned count equals the filtered provider total proves absence. Errors/malformed/partial/unrelated results prove nothing and do not starve later subsets/pages. Canonical writes remain separate 25-identity batches, preserving per-identity failure isolation and missing-profile company confirmation. The fifteen-minute interval and all owner/consent/retention rules remain.

## Operating a stalled cleanup

First identify the exact deployment and inspect the durable owner, current phase/cursor/generation, job ID and native scheduled-function state. Fix the cause before running the corresponding internal resumer:

- Account deletion: accountDeletion:resume.
- Cleaning company deletion: companyDeletion:resume.
- Deleted contract children: contractCleanup:resume.
- Removed membership showing records: buyerLinkShowingCleanup:resume.
- Unfinished email recovery: emailDeliveries:resume with the sending, failed or uncertain state.
- Expired pending/deleting source: templateSetup:expirePending with `{}` to discover both states; optional `state` is `pending` or `deleting`, with an optional pagination `cursor`.
- All conditional local recovery families: recovery:resume.
- Interrupted orphan-file interval: storageOwnership:cleanOrphanFiles with no continuation args, which resumes the stored active cursor/cutoff.

These are operational instructions, not authorization to mutate a deployment. Never delete dispatched consent or a completed account/company tombstone to clear an error. Prepared-consent expiry/cancellation is conditional on its current request identity; stale callbacks cannot undo dispatch. Delayed children cannot recreate missing parents.

## Strict-release marker obligations

The strict schema contains no raw-activity phase/cursor compatibility. Before release, G08–G10 require every old account/company marker and callback to finish or be deliberately normalized under the preserved old bundle. Old company raw-opening phases also drained current activity/counters; catch up current openings, receipt children and counters even when a marker has already advanced. Preserve selective current account activity erasure and do not infer completion from zero raw tables. The [preservation runbook and exact gates](backend-preservation-cutover.md) cover this prerequisite; all live gates remain UNVERIFIED. Local source changes perform no target normalization or deletion.

## Verification

Existing suites use controlled state and timers. Native scheduler, storage and
concurrency behavior, provider responses and browser consent flows require separate
verification.

Buyer links and showing records are included in bounded contract cleanup and in
company cleanup before contracts/template history. Removing the contract immediately
denies public access, even while child cleanup is pending. Company deletion holds pause
buyer access; cancelling the hold restores it. A departing link creator or a CRM
association change does not invalidate an existing buyer snapshot.
