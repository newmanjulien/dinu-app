# Task delegation

Current architecture: [backend model](backend-redesign/architecture.md). Target/archive/reset/deploy and remaining native/browser/provider verification: [Phase 18](backend-redesign/phase-18-activation.md). Local implementation evidence does not establish deployment.


Delegation records an admin’s request and attachments. Submission intentionally
sends no notification and executes no work. The current backend implementation
and verification record are in [Phase 15](backend-redesign/phase-15-delegation.md).

## Catalog and form ownership

The admin-only workspace owns `DelegationWidget`. The widget keeps one live
catalog subscription while enabled at the desktop breakpoint or while its modal
is open. Enablement and arguments remain stable through expansion/collapse;
reopening a failed/missing catalog changes the refresh token. The modal is loaded
on demand with the shared component loader; its existing loading/retry state and
transport-generation invalidation remain. The delegate’s avatar uses the shared
avatar URL resolver.

Selecting, configuring and reviewing a task are local form state. Live catalog
revisions reconcile matching question keys, remove obsolete answers and invalidate
configuration. Removing the selected task resets its form and discards staged
files. A definitive stale submission carries the rejecting transaction’s catalog
snapshot; recovery retains a newer live revision. An uncertain submission retains
its frozen catalog, normalized payload and operation ID until its outcome is known.

The global catalog has three tasks, each with one required task-specific brief and
a two-business-day deadline. `delegation.seedCatalog` is the sole catalog writer;
unchanged content preserves its revision. Task titles, descriptions and question
copy remain in [delegation.ts](../src/convex/delegation.ts).

## Data and transactions

| Record | Ownership |
| --- | --- |
| `delegationCatalog` | Global revisioned delegate/tasks, retained through company deletion. |
| `delegationRequests` | Company business record and scoped submission receipt; normalized answers, attachment IDs, immutable task/delegate snapshot, submitter and original deadline. |
| `delegationAttachments` | Company/uploader/draft/upload/storage identity and metadata; staged with expiry or submitted with a request reference. |
| `delegationCancellations` | Temporary company/uploader/draft/upload fences; null upload ID cancels the whole draft. |

Every public operation and upload checks current membership and admin role.
Submission resolves its scoped receipt before current catalog/file checks.
Matching normalized replay returns the original request/deadline; a different
payload cannot reuse that operation. New submission validates catalog questions,
staged ownership/expiry and actual storage metadata, then creates the request and
claims its selected files atomically. Authorization/transport uncertainty retains
the frozen operation; definitive business/stale rejection permits the existing
form recovery. Account-only deletion retains submitted company business data;
company deletion drains attachments, requests and cancellation markers.

## Attachment lifecycle

Shared limits in [delegation.ts](../src/lib/delegation.ts) retain three raw DOCX/PDF
files of 10 MiB each, 255-character filenames, twenty answers and 10,000 characters
per answer. The current catalog uses one answer per task. Draft IDs are allocated
only for the first valid file or when freezing a submission; opening/selecting a
task creates no empty draft or cleanup work.

The live draft query returns only ID, upload ID and expiry and owns readiness.
Local rows retain their File and current attempt. Live confirmation settles a
pending upload; query loading/error is not treated as deletion. Disappearance or
expiry invalidates configuration, and reupload uses a fresh upload ID. Registration
reclaims expired staged rows before enforcing the existing three-file bound.

The HTTP action checks authorization before ingestion, bounds the body stream,
checks the eight-byte PDF signature or full DOCX ZIP directory, and stores raw
bytes. A fresh **internal mutation** checks cancellation before reading the body;
registration independently rechecks current access, its action-minted ten-minute
deadline, cancellation, MIME/size, retry identity and draft capacity. The approved
expiry correction makes a cancelled ID eligible when its 24-hour marker expires,
without waiting for marker deletion. Error wording/status precedence remains.

Discard writes an upload-specific or draft-wide marker and releases matching
staged files in one transaction. Registration either precedes cancellation and
gets removed, or follows it and is refused. Marker retention exceeds the action
deadline so a stalled upload cannot outlive cancellation. Staged release removes
its attachment reference before checking all indexed baseline/attachment/avatar
owners and deleting unowned bytes. Submitted files cannot be discarded by the form.
Failed/uncertain registration and duplicate bytes use the same scheduled
reference-aware discard. Interrupted operations retain the existing expiry/orphan
recovery; company-wide and all-kind recovery acceptance remains Phase 16.

Staged files and cancellation markers expire after 24 hours. Each thirty-minute
cron drains indexed 25-row batches and schedules a continuation when full. The
daily orphan sweep is a separate recovery path; its all-kind completion belongs
to Phase 16B.

## Waits, sessions and dates

Upload waits remain sixty seconds; removal/submission waits remain thirty seconds.
A timed-out mutation remains tracked. Removal and submission retries reattach to
pending work, and submission retains the same frozen operation after settlement
until its result is known. Unresolved removal blocks submission. Late success can
settle during temporary auth recovery while the component’s session is still valid;
new work remains blocked. Session/membership/preparation/transport changes tear
down local waits. Close/task changes cancel staged work, with TTL recovery for
interrupted or unauthorized cleanup.

Deadlines exclude the submission date and count Monday–Friday in America/Toronto,
without a holiday calendar. The server records the first submission’s deadline.
The client keeps its existing midnight/nearest-expiry timer and visibility/configure/
submit refreshes, including Toronto DST boundaries.

## Development and verification

Run `npm run verify` and
`npx tsc --noEmit -p src/convex/tsconfig.json` for the required local checks.
The existing suites cover contract lifecycle, saving, creation, caching, scheduling
and account startup; they do not certify delegation races or browser/provider
behavior. Phase 15 additionally records controlled local HTTP, replay/cancellation,
state, ownership, batch and size diagnostics without adding persistent tests.
The local storage runtime omits Blob MIME metadata, so those diagnostics supply
it explicitly; native storage/HTTP/OCC and recovery remain separate acceptance.

Catalog edits require a target-specific backend deployment and seed refresh.
Use the chosen Phase 18 activation procedure; no deployment is authorized by this
document. The October 23, 2026 development checks and catalog revision 4 describe
an earlier implementation and do not certify the current backend. No deployment,
provider setup, email send or browser check occurred in Phase 15. Loops setup/live
testing remains deliberately deferred to Phase 18.

The local portrait `static/delegation-julien.jpg` is an illustrative Unsplash image,
not a verified photo of Julien.
