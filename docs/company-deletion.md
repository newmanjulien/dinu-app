# Account and company deletion

Account deletion keeps Clerk's client `user.delete()` call and reverification.
Company deletion adds durable consent and reuses the same verified deletion marker,
bounded cleanup, scheduled job generation, and reconciliation model.

## Consent and eligibility

The server determines deletion mode from authenticated identity and current company
membership. An owner with another live colleague must transfer ownership first.
Other members delete only their account with `delete my account`. The last live
member deletes both with `delete my account and company`, regardless of personal
role. Pending invitations are not members; profiles with verified deletion markers
are not live colleagues. Eligibility scans stop at the first live colleague and
reject conservatively after 100 memberships awaiting cleanup.

Company requests have four states:

| State        | Meaning                                                                           | Cancellation and expiry                                               |
| ------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `prepared`   | The authenticated member supplied the current combined phrase.                    | Can be cancelled; expires after 15 minutes.                           |
| `dispatched` | The server validated the exact request immediately before the client calls Clerk. | Retained until deletion is confirmed; cannot be cancelled or expired. |
| `cleaning`   | A signed webhook or complete successful Clerk lookup confirmed deletion.          | Company access is blocked and cleanup resumes until complete.         |
| `complete`   | Company data and avatar have been removed.                                        | Permanent tombstone.                                                  |

Preparation returns the request ID, attempt ID, timestamp, and state. The same
attempt is idempotent. A different attempt supersedes only a preparation; retries
reuse an existing dispatched request. Dispatch checks authenticated identity,
current eligibility, company ID, phrase, request ID, attempt ID, and preparation
freshness in one transaction. Concurrent membership changes conflict with its
indexed reads. Account-only dispatch checks eligibility without creating a hold.

Automatic cancellation supplies the captured request and attempt IDs, so an old
callback cannot cancel a newer preparation. Explicit cancellation targets the
current preparation. Both return their actual outcome; dispatch always prevents
later cancellation. Client generation and identity checks discard stale callbacks.
A lost response or Clerk error preserves dispatched consent. Reverification retries
the same request. The `prepare` protocol argument rejects older clients before
they can call Clerk without dispatching a durable request.

Preparing or dispatching places the company on hold through the shared company
authorization check. Preparation expiry or cancellation releases that hold.
Deleting an account externally while its request is only prepared releases the
preparation and follows account-only cleanup and ownership recovery. It does not
authorize company deletion.

## Cleanup and recovery

Verified account deletion records an issuer-qualified `deletedUsers` marker and
confirms any dispatched company request in the same transaction. This also works
when no profile remains. Repeated webhooks are idempotent. Account cleanup removes
the membership, profile, and personal avatar. Without company consent it retains
business data and transfers an externally deleted owner's company to the oldest
live remaining member, or leaves it ownerless for internal recovery.

Company cleanup drains invitations, approvals, legacy notifications, shared email
deliveries and snapshots, current reviewer attribution, decisions, contracts, compact
contract-directory entries, live blocks,
live items, immutable snapshot blocks, immutable snapshot items, item receipts,
contract receipts, versions, the current-template pointer, memberships, and finally
the company and its avatar. Snapshot children have required indexed `companyId`
fields; cleanup needs no parent-by-parent traversal. Receipts survive individual
target deletion but are purged with the company. New scope always comes from
validated server context.

Each transaction shares one 100-row budget across every phase and also checks
remaining read/write bytes, document/query limits, and scheduling capacity. It
reserves room for the next full-size row, approval job cancellation, progress,
and one continuation. Memberships and the company remain until business cleanup
finishes. Every continuation uses a generation; superseded jobs do no work.
Email cleanup cancels tracked dispatch, recovery, and invitation expiry jobs before
removing delivery records and bounded snapshots. Already dispatched SMTP cannot
be recalled.

Every 15 minutes Clerk reconciliation scans profiles and dispatched company
requests independently, in pages of 25 identities. The company scan recovers
requests even after profile cleanup. A lookup establishes absence only if all
returned IDs were requested, are unique, and the returned count equals Clerk's
total count. API errors and incomplete responses retain consent without starting
cleanup. Missing identities are recorded in bounded batches with individual
failure isolation. Recovery also expires abandoned preparations without a Clerk
lookup and resumes cleaning requests in pages of 10, advancing past failures.

Inspect the marker state, phase, cleanup generation, job ID, and scheduled-function
failure. Fix the cause, then run internal `accountDeletion:resume` or
`companyDeletion:resume` against the explicitly identified deployment. Never
delete dispatched consent to clear an error. Keep completed account and company
markers to deny deleted identities and delayed internal work.

## Schema reset

Company scope is required on snapshot manifests, immutable revisions, and operation
receipts. Company deletion uses only the canonical storage model. There is no
backfill helper, migration gate, or conversion phase. Before deploying over
incompatible records, follow the
[fresh reset procedure](private-companies-rollout.md#fresh-development-reset).

## Manual verification

Use disposable development accounts and companies. These checks are not covered
by the existing performance suite:

- Prepare, retry the same attempt, supersede it from another tab, and deliver a
  late automatic cancellation. Only the matching preparation can be cancelled.
- Race expiry, explicit cancellation, membership changes, and dispatch. An expired
  or superseded request cannot dispatch; a dispatched request cannot be removed.
- Trigger reverification, lose a dispatch or Clerk response, replace the modal,
  and retry. Dispatched consent survives and stale callbacks cannot call Clerk.
- Delete externally during preparation and after dispatch. Only the latter starts
  company cleanup; repeated signed webhooks do not create another active chain.
- Drain more than 100 records spread across phases and large snapshot records.
  Confirm one bounded continuation, children before versions, and company last.
- Fail the first recovery request and confirm later pages still progress. Remove
  a dispatched request's profile before reconciliation and verify fallback recovery.
- Return partial or failed Clerk lookups. They never establish deletion. Compare
  scoped counts and receipt retention after account-only and combined deletion.

`npm run verify` checks the existing saving, conflict, retry, creation, publication,
scheduling, and cache guarantees, Svelte types, and the production build. Convex
backend type checking and strict-schema deployment check backend integration and
canonical record shape. These do not certify live Clerk or browser races.
