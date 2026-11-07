# Account and company deletion

Current architecture: [data model](data-model.md). Release mechanics: [production releases](deployment.md).

This runbook describes account and company cleanup. Native, provider and browser
behavior require separate verification. Accounts normally leave through the app, and most companies remain active after individual departures.

## Consent and eligibility

Account deletion retains Clerk's client deletion call and reverification. The server determines the existing deletion mode from authenticated identity, current membership and live colleagues:

- An owner with another live colleague transfers ownership first.
- Other members delete their account with the existing confirmation phrase, keeping company business data.
- The last live member confirms both account and company deletion, regardless of personal role.
- Pending invitations and profiles with verified deletion tombstones are not live colleagues. Eligibility stops at the first live colleague and rejects conservatively after 100 memberships awaiting cleanup.

Company consent has four states:

| State      | Meaning                                                                                                  | Expiry/cancellation                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Prepared   | Current authenticated member confirmed combined deletion                                                 | Matching preparation can be cancelled; expires after fifteen minutes |
| Dispatched | Exact request/attempt and current eligibility were revalidated immediately before the client calls Clerk | Retained until account deletion is confirmed; no cancellation/expiry |
| Cleaning   | Signed webhook or a complete provider lookup confirmed account deletion                                  | Company stays unavailable while bounded cleanup progresses           |
| Complete   | Company scope and final company/avatar reference were removed                                            | Permanent tombstone                                                  |

The schema pairs prepared/dispatched consent with the initial phase, cleaning with the complete phase list and completion with the final company phase. Job IDs remain optional during allocation/completion; no extra record field is needed.

Same-attempt preparation is idempotent; a new attempt supersedes only prepared consent. Dispatch checks identity, membership/eligibility, company, phrase, request ID, attempt and freshness together. Membership changes conflict with its indexed reads. Account-only dispatch creates no company hold.

Automatic cancellation carries its captured request/attempt identity. Explicit cancellation targets the current preparation. A lost response or Clerk error preserves dispatched consent; reverification retries that request. Preparing/dispatched consent holds company activity until cancellation, expiry or completion. External account deletion during preparation removes that preparation and follows account-only cleanup; it cannot authorize deleting the company.

## Retention and ownership

Verified deletion records a permanent issuer-qualified account marker and confirms dispatched company consent in the same mutation, including when no profile remains. Repeated webhooks are idempotent.

Account cleanup removes the profile/membership and safely releases the personal avatar. It retains company contracts, source/playbook template versions, creation receipts, immutable decisions, email events/captured selections and invitations. Historical actor/uploader/creator IDs remain business history; live access/recipient resolution still checks current membership and deletion markers. The existing directory displays Former colleague for a departed creator.

An externally deleted owner transfers to the oldest live remaining member. A bounded 25-membership successor page persists its cursor before continuing; the profile remains until ownership is resolved. A company with no live successor becomes ownerless for the existing internal recovery path. Dispatched company consent instead authorizes company cleanup.

Company cleanup uses the [single ordered phase list](../src/convex/deletionValidators.ts): invitations, approvals, deliveries/snapshots, decision receipts, contracts/directory/cleanup markers, baseline chunks/live items/create receipts/version history/pointer/baselines/revisions, memberships and finally the company. The complete matrix maps every current table. Profiles, account tombstones and global sweep progress have separate owners.

Item/contract creation receipts survive individual target deletion to prevent retry resurrection. Shared template versions/revisions/source survive individual contract/item deletion. Company deletion purges its receipts and business history but retains its completed tombstone. There are no legacy notification, attribution or copied-snapshot tables to drain.

File release removes the owner's reference, then reads all baseline/profile/company ownership indexes before deleting storage in the same mutation. This covers account/company avatars, company baseline originals and expired prepared baselines. Another owner preserves the bytes. Interrupted unreferenced uploads/exports are recovered by the all-kind, exact 24-hour grace-protected sweep. It uses bounded 25-row/1 MiB metadata pages, a durable creation frontier/cursor/cutoff and stale-continuation fencing. Each page checks all three ownership indexes before deletion; storage failure rolls back file and progress changes. A normal daily root resumes an interrupted interval.

## Bounded cleanup and recovery

Company/contract/retired-delivery/expired-baseline child drains share a 100-primary-row budget, counting nested snapshot rows. Native remaining metrics reserve 4,000,000 read/write bytes, 64 queries/read/write documents, one continuation and 1,024 scheduled argument bytes. They leave room for cancellation, reference release, parent deletion and marker progress. These are reserves, not new customer limits. A delivery remains until its captured chunks drain.

Account/company/contract/disposal workers store their current job/generation. Resumption keeps pending/in-progress jobs, rearms missing/failed/cancelled/finished jobs and advances the generation. Stale generations are no-ops. Unexpected mutation failure rolls back the batch and leaves its durable owner discoverable. Company deletion cancels tracked contract/send/recovery/disposal/invitation-expiry work; an already dispatched external email cannot be recalled.

Baseline expiry uses its own ID/state/deadline and remaining indexed chunk prefix. An active baseline or a missing row makes a delayed callback a no-op. Each yielding invocation schedules one continuation; duplicate expiry callbacks can perform additional bounded work. It does not maintain an exclusive generation/job marker. Thirty-minute discovery independently pages expired prepared/deleting states, reaching later uploads even if earlier workers fail.

Quarter-hour reconciliation invokes one bounded local recovery mutation before provider configuration/lookup. Nine indexed first-record probes schedule only nonempty account/company/contract/disposal/consent/unfinished-email/dispatched-company families; errors are isolated and workers page independently. The exact expired-preparation range excludes fresh consent. Delivery resumption restores the existing recovery rule: missing jobs do not establish non-delivery, claimed attempts become uncertain, uncertain decisions never automatically resend, and uncertain approvals only become eligible for an explicit retry after the existing ten-minute cooldown. Terminal/exhausted/retired attempts remain untouched.

Clerk profile/dispatched-company discovery targets 100 native rows with explicit 100-row/2 MiB caps and preserves native pagination metadata. Filter the configured issuer, deduplicate IDs, then split every provider request at 100 IDs independently of page length; its limit equals its ID count. Only a complete duplicate-free/requested-ID-only response whose returned count equals the filtered provider total proves absence. Errors/malformed/partial/unrelated results prove nothing and do not starve later subsets/pages. Canonical writes remain separate 25-identity batches, preserving per-identity failure isolation and missing-profile company confirmation. The fifteen-minute interval and all owner/consent/retention rules remain.

## Operating a stalled cleanup

First identify the exact deployment and inspect the durable owner, current phase/cursor/generation, job ID and native scheduled-function state. Fix the cause before running the corresponding internal resumer:

- Account deletion: accountDeletion:resume.
- Cleaning company deletion: companyDeletion:resume.
- Deleted contract children: contractCleanup:resume.
- Retired email capture: emailDisposal:resume.
- Unfinished email recovery: emailDeliveries:resume with the sending, failed or uncertain state.
- Expired prepared source: baselineUploads:expirePrepared.
- All conditional local recovery families: recovery:resume.
- Interrupted orphan-file interval: storageOwnership:cleanOrphanFiles with no continuation args, which resumes the stored active cursor/cutoff.

These are operational instructions, not authorization to mutate a deployment. Never delete dispatched consent or a completed account/company tombstone to clear an error. Prepared-consent expiry/cancellation is conditional on its current request identity; stale callbacks cannot undo dispatch. Delayed children cannot recreate missing parents.

## Verification

Existing suites use controlled state and timers. Native scheduler, storage and
concurrency behavior, provider responses and browser consent flows require separate
verification.
