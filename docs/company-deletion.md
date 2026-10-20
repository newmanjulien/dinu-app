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

Company cleanup drains invitations, approvals, decisions, contracts, live blocks,
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
Approval cleanup cancels pending or running send jobs before removing their rows.

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

## Migration to required company scope

The final backend has required scope, no legacy request state, and no migration
gate or helper. An existing deployment with unscoped records must use the compatible
backend before this strict schema. Retain that backend and its internal migration
module with the deployment's snapshot; do not push the strict schema first.

1. Identify and announce the exact deployment. Export all data with storage and
   retain matching code/configuration privately. Production changes require their
   own authorization and a rehearsal on a snapshot-seeded nonproduction deployment.
2. Set `COMPANY_DELETION_MIGRATION=paused`, then deploy the compatible backend with
   optional company IDs and their indexes. It pauses combined preparation,
   dispatch from preparation, and company cleanup. Account-only deletion remains
   available; already dispatched consent remains durable.
3. Run internal `companyDeletionMigration:backfill` for `templateVersionBlocks`,
   `templateVersionItems`, `creationReceipts`, and `contractCreationReceipts` until
   each returns zero processed records. Each transaction handles at most four
   full-size records plus parents and resumes through the missing-scope index.
4. Snapshot children derive company scope from their version. A missing version or
   an embedded item disagreeing with its version stops migration. Receipts derive
   scope from the live target or the originating membership encoded in the
   operation key. Conflicting scope or a malformed membership ID stops migration.
   A receipt is removed only when both its target and originating membership are
   gone; an individual target deletion alone does not justify removing it.
5. Page through `companyDeletionMigration:restart`. Conservatively convert legacy
   `awaitingAccountDeletion` requests to `dispatched` because historical data cannot
   prove Clerk was never called. Cancel active cleaning jobs, increment their
   generation, clear their job IDs, and restart their phase at `invitations` so
   newly scoped children and receipts cannot be skipped.
6. Require an empty `companyDeletionMigration:remaining` result. Export and audit
   snapshot-parent and receipt-target/membership scope, retained record counts,
   and unchanged business content. Resolve conflicts before proceeding.
7. Make all four company IDs required, remove the legacy state, migration helper,
   and gate, regenerate types, and deploy the final backend. Remove the temporary
   environment variable and resume company cleanup. Archive the migration results.

The October 9, 2026 development migration targeted `scrupulous-squirrel-986` in
`agreed-feedback`. Its private snapshot with storage and compatible backend are
retained in the directory recorded by `/tmp/agreed-company-deletion-backup-path`.
The backfill scoped 113 snapshot blocks, 56 snapshot items, and three contract
receipts without removing records. Snapshot-parent and receipt scope audits passed;
all business records and storage were unchanged. The final strict schema is deployed,
the temporary environment variable is removed, and the cleanup recovery sweep has
run. Production was not changed.

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
migrated record shape. These do not certify live Clerk or browser races.
