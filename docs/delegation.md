# Task delegation

The admin-only `DelegationWidget` opens `DelegateTaskModal` using the shared
`ModalShell` panel variant, aligned right with a 640px maximum width and 28px
content padding. Help uses the centered panel variant with a 480px maximum width
and the shared 24px padding default. All modal surfaces use the shared modal radius;
panels fill the viewport with square corners on mobile. Selecting, configuring,
and reviewing a task are local form state. Submission creates a request without
notifications or task execution.

## Catalog and loading

The workspace imports the widget only for admins. Its module statically imports the
modal, so modal code is ready before the widget becomes clickable. At the desktop
breakpoint, including while collapsed, the widget owns one live catalog subscription
and preloads the delegate's avatar using the same URL resolver as `Avatar`. The modal
consumes that catalog. Early clicks retain the existing loading state.

A derived enablement flag and query arguments keep the subscription stable through
expansion, collapse, and breakpoint changes that leave it enabled. It remains enabled
while the modal is open below the breakpoint. Reopening after an error or missing
catalog changes a refresh token to avoid reusing a cached failure. A definitive stale
submission rejection carries the rejecting transaction's catalog snapshot; recovery
uses that snapshot directly and retains any newer live revision.

Live catalog revisions retain answers for matching question keys, initialize new
questions, drop obsolete answers, and invalidate configuration. Removing the selected
task resets its form and discards staged files. An uncertain submission retains its
frozen catalog, payload, and operation ID until its outcome is known.

Task selection shows and searches titles only. Task icons are absent from the UI,
catalog, and saved request snapshots. Each task's longer
description appears at the top of Configure. The catalog defines one required,
task-specific brief per task, alongside optional uploaded attachments. Submission
validates the same catalog questions rendered by the form.

## Data and transactions

- `delegationCatalog`: one shared revisioned catalog with three tasks and Julien's
  profile. Stable question keys connect answers to labels. The internal idempotent
  `delegation:seedCatalog` keeps the revision when content is unchanged.
- `delegationRequests`: company, authenticated submitter, scoped operation ID,
  normalized payload, immutable task/person snapshot, submission time, and deadline.
- `delegationAttachments`: company/uploader/draft ownership, upload ID, storage ID,
  and metadata; either staged with a 24-hour expiry or submitted with a request reference.
- `delegationCancellations`: company/uploader/draft/upload cancellation markers with
  a 24-hour expiry. A null upload ID cancels the whole draft. This additive table
  requires no backfill of existing requests or attachments.

Every public query, mutation, and HTTP upload checks current membership and admin role.
Submission looks up the scoped operation before business validation, then validates
catalog/attachment ownership and creates the request and claims its files atomically.
Existing operations require the same normalized payload. Only business rejection after
an authorized lookup finding no existing request is marked definitive. Authorization,
transport, and other uncertain failures preserve the frozen operation ID.

## Attachments and request lifetimes

Draft IDs are allocated only for the first valid file or when freezing a submission.
Opening the modal and selecting tasks create no empty drafts, queries, or cleanup calls.
The live staged-file query returns only ID, upload ID, and expiry; it owns attachment
readiness. Local rows retain their File and upload attempt information. Live confirmation
settles the upload immediately even when HTTP is pending. A loading/error query is not
treated as deletion. Disappearance or expiry of a confirmed file invalidates configuration;
reupload uses a fresh upload ID. Registration removes expired staged rows from the bounded
draft before enforcing its three-file limit.

DOCX/PDF files remain raw documents, limited to three files of 10 MB each. PDF signature
validation reads eight bytes; DOCX validation inspects the ZIP directory. Registration
returns compact IDs without rereading its inserted document. Reference-aware orphan
cleanup is scheduled only for failed/uncertain registration or duplicate storage.

Removal writes a cancellation marker and deletes matching staged files in one transaction,
even without an attachment ID. Both upload authorization and registration check markers,
so registration either precedes cancellation and is deleted, or follows it and is refused.
The HTTP action mints a ten-minute registration deadline, shorter than marker retention,
preventing a stalled action from outliving cancellation. Expiry cleanup uses indexed
25-row batches. Company deletion drains files, requests, and cancellation markers.
Submitted files cannot be discarded by the form.

Removal and submission waits time out after 30 seconds; HTTP upload waits after 60 seconds.
A timed-out mutation remains tracked. Removal retries reattach to the pending mutation,
and submission cannot proceed while removal remains unresolved. Submission retries
reattach to the same pending promise; once it settles, any further retry uses the same
frozen operation. Late success is accepted while the component's session lifetime remains
valid. New operations are blocked during temporary authentication recovery; pending work
may settle. Closing or changing membership, session preparation, or transport generation
tears down the widget/modal and disposes local waits. Close/task changes cancel staged
uploads; TTL cleanup handles interrupted or unauthorized cleanup.

Deadlines count Monday–Friday in America/Toronto, excluding the submission date and
without a holiday calendar. The server records the first submission's deadline. The
client has one timer for the next Toronto midnight or nearest attachment expiry and
refreshes on visibility, configuration, and submission; its date boundary handles DST.

## Review coverage

All findings from the three review passes are implemented; grouping did not remove
independent cleanup obligations.

| Finding | Resolution / source evidence                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------- |
| R1.1    | Error/null reopen changes `refreshToken` in the widget.                                                                     |
| R1.2    | Derived `catalogEnabled` and `catalogArgs` stabilize the subscription.                                                      |
| R1.3    | `DelegationWidget` and delegation CSS names replace booking names; the existing dismissal key remains compatible.           |
| R2.1    | `discard` cancels by upload ID; `checkCancellation` guards both upload stages.                                              |
| R2.2    | `attached` uses live staged rows/expiry; unavailable retries use new upload IDs.                                            |
| R2.3    | The modal owns a disposable midnight/expiry timer and explicit clock refreshes.                                             |
| R2.4    | Draft allocation occurs only in valid file selection or submission freezing.                                                |
| R2.5    | Orphan cleanup runs only when registered storage differs or is unknown.                                                     |
| R2.6    | PDF validation uses `blob.slice(0, 8)`.                                                                                     |
| R2.7    | Registration returns `{ attachmentId, storageId }` directly.                                                                |
| R2.8    | Nullable configuration revision replaces the boolean; typed staged files and the scoped index remove both redundant guards. |
| R3.1    | Definitive rejection follows authorized operation lookup; pending submissions remain single flight.                         |
| R3.2    | Live confirmation resolves/aborts the current upload wait.                                                                  |
| R3.3    | Removal has a bounded local wait and separately observes eventual settlement.                                               |
| R3.4    | Stale rejection includes a catalog snapshot; no cached query recovery remains.                                              |
| R3.5    | Live revision reconciliation clears removed tasks and their drafts.                                                         |
| R3.6    | `canDispatch` checks `session.blocked` separately from lifetime validity.                                                   |
| R3.7    | The shared workspace dynamically imports delegation only inside its admin branch.                                           |
| R3.8    | `draftAttachments` projects staged rows to three fields.                                                                    |
| R3.9    | Widget preload and `Avatar` share `resolveAvatarUrl`.                                                                       |

## Development and verification

The catalog is stored on the development deployment `scrupulous-squirrel-986`.
After editing its descriptions or questions in `src/convex/delegation.ts`, push the
backend and refresh the stored catalog:

Publishing the Dinu rename also requires this refresh so the stored task
descriptions use the new app name. The repository rename does not update deployed
catalog content.

```sh
npx convex run --deployment scrupulous-squirrel-986 delegation:seedCatalog '{}' --push --typecheck enable
```

The cleanup backend was pushed to this development deployment on October 23, 2026.
Read-only live checks confirmed that `getCatalog` accepts both initial and retry
refresh tokens and returns all three tasks for an authenticated admin. The deployed
`discard`, `registerUpload`, and `draftAttachments` contracts also match the frontend.
The catalog was subsequently refreshed to revision 2 with the longer Configure
descriptions and one required brief per task. Existing requests retain their original
task snapshots; open forms reconcile through the existing revision handling.

Task icons were then removed. The icon field was briefly optional while
the stored catalog was refreshed, then removed from the shared task validator used by
both catalog and request snapshots. A live check found no existing requests to migrate.
The final deployment has catalog revision 4. Its schema accepts no task icon field
and retains no legacy compatibility path.

Run `npm run verify` and `npx tsc --noEmit -p src/convex/tsconfig.json` after backend changes.
The existing performance suite covers contract saving, creation, caching, scheduling,
and account startup. It does not automatically prove delegation authorization, concurrent
cancellation/registration, lost-response handling, or browser latency. Source review and
build import-graph inspection supplement these checks. Live catalog and contract
verification does not prove upload/submission races or browser behavior. No new tests
or browser automation are part of this cleanup.

The local portrait `static/delegation-julien.jpg` is an illustrative portrait downloaded
from Unsplash, as requested, rather than a verified photo of Julien.
