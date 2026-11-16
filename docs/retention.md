# Contract output retention

`contractOutputs` owns captured export evidence independently of retry receipts.
`contractOutputChunks` owns its paged proof. Word attempts (`hubspotExports`), Quote
pushes (`hubspotQuotePushes`) and output rows have explicit full and compact shapes.
The [data model](data-model.md#email-caches-and-maintenance) describes their callers;
the [backend plan](work/backend-simplification-plan.md#d2--separate-replay-output-evidence-native-ownership-and-document-lifetime)
records the design. These are local source contracts, not a certificate of populated
deployment conversion or live provider behavior.

## Separate clocks and holds

| Owner or obligation                                                                           | Earliest end condition                                                                                                             |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Contract operation, creation and ordinary discussion replay                                   | Original `op1` time plus seven days ends mutation admission; another 24 hours permits physical collection after dependency cleanup |
| Unreleased abandoned output with no external effects                                          | Original operation expiry and completed private preparation/proof/native cleanup                                                   |
| Local Word download eligibility                                                               | Original reservation plus one hour; retries return the same adopted bytes                                                          |
| Local file storage                                                                            | Last independent eligibility/attachment hold plus 15-minute physical read grace, then confirmed storage deletion                   |
| Download acknowledgement admission                                                            | Server-recorded first `releasedAt` plus seven days; client `initiatedAt` cannot extend it                                          |
| Independent attachment entitlement                                                            | Up to 30 days after the first server acknowledgement; positive File adoption can end it earlier                                    |
| Quote private HTML                                                                            | Existing 30-day provider payload schedule, independently of evidence and factual outcome                                           |
| Full settled output manifest/proof                                                            | Immutable `settledAt` plus 90 days, and every independent hold released                                                            |
| Compact output/attempt/provider fact and successful canonical fence                           | Company lifetime                                                                                                                   |
| Unknown/dispatched/verifying/attention provider work, unresolved delivery/email or live lease | Factual reconciliation/lease closure; no fixed evidence TTL                                                                        |
| Hourly maintenance and deleted-contract waiting hints                                         | Discovery/backoff only; these never change the deadlines above                                                                     |

Word settlement is its first successful release. A Quote push receives its first
`settledAt` only at a conclusive verified/rejected/retired transition after work,
claims and leases end. Its requesting output settles at the later of the original
request commit and that provider settlement. Reuse of an old settled push therefore
retains a new request's own observation time. Reads, retries, diagnostics,
`updatedAt` and acknowledgements cannot move settlement or the 90-day deadline.
Unresolved work has no invented settlement time.

Compaction independently checks private preparation/receipt backlinks/proof garbage,
provider and activity outcomes, jobs/claims/leases, file/payload deletion, attachment
entitlement, acknowledgement closure and any active contract-deletion proof preflight.
Expiry first clears executable `fileId` and records `deletingFileId`; that obligation
ends only after an actual `_storage` absence check. Missing responses, expired bytes
and contract deletion never prove that an external write did not happen. Diagnostic
evidence required by unresolved Quote work survives its ordinary diagnostic expiry;
this does not extend private payload bytes or permit another create.

## Full evidence and compact history

A full output stores the original captured manifest once with its canonical hash,
source/actor/destination bindings and proof lifecycle. Proof seals and four-chunk
folds verify section/generation ownership, order, record counts, bytes, fingerprints
and final hashes. Replay receipts keep bounded output references, not another copy
of the manifest or full proof. Private reservation preparation alone uses a receipt
backlink, which activation/retirement clears atomically.

After all gates pass, bounded proof drainage precedes in-place compact replacement.
The output retains company/contract/kind and observation identity, title, profile and
membership IDs, original request/release/acknowledgement times, filename/hash/size,
document/source/proof fingerprints, captured destination and terminal remote File/Note
facts. A Word attempt keeps its physical ID and factual acknowledgement metadata.
A Quote push keeps its original output ID, destination, canonical key, fingerprint,
payload hash, settlement and known/previous quote ID/link/state/message. Terminal
activity/delivery references are resolved atomically with conversion after their
facts are captured; unresolved consumers prevent conversion.

Compact shapes discard exact input/result JSON, actor email snapshots, execution
claims/tokens/jobs, direct source-document references, manifests/proof fragments,
payload/file references and detailed recovery/failure bytes. Compact readers certify
historical identity and observed outcomes. They cannot regenerate/release a file or
reconstruct every original wording, approval or actor-email detail. There is no
promise of indefinite full reconstruction. Abandoned effect-free owners are disposed
rather than leaving a compact attempt with a missing output.

Successful canonical provider fences and compact summaries survive for company
lifetime. Canonical reuse observes the existing push without transferring its output
owner or dispatching again. The live root's constant-size `quoteRequests` watermark
allocates `max(serverNow, watermark + 1)` for each new reservation; exact retry does
not allocate again. Commit advances `latest` only for a newer reservation, including
reuse, so out-of-order preparation cannot replace the newest committed request.
Latest reads use that pointer and a full/compact summary after normal access checks.
The root pointer disappears with the contract; provider facts survive until company
erasure under the existing provider rules.

## Native ownership before receipt deletion

Native promotion walks the actual `stage.receiptId` indexes for documents, changes
and decisions. Only a surviving actual-owner row with a complete owner, sealed stage,
matching company/contract, exact adopted generation and corresponding original
`nativeResult` membership may have `stage` cleared. Promotion preserves payloads,
IDs, bytes/chunks/hashes, source/predecessor references, actors, timestamps and revisions.

A historical result may name a missing/already-promoted row or borrow a document from
another receipt; neither grants ownership of another receipt's private stage. A
surviving named actual-owner row with a mismatched seal fails closed. Obsolete or
unadopted private rows drain under their existing native garbage owner. Private native
document uploads retain fresh exclusive chunks. Bounded first-range progress needs no
permanent adoption ledger, and version/deadline/generation fences reject stale append
or adoption. The original receipt result/seal stays until promotion, obsolete-generation
cleanup and native section disposal all finish.

## Shared document lifetime

Ordinary immutable manifests share unchanged chunks. Every historical ordinary
manifest/chunk remains for a **live contract's lifetime**; there is no per-document
or 90-day chunk reclamation promise for a live contract, and saves add no chunk
reference-count writes.

After logical contract deletion, bounded preflight retires private operations,
finishes exact native ownership work and verifies every retained full output proof
and named document/chunk before source removal. Every full output, including one in
transient compaction/disposal, holds the entire remaining document set. One unresolved
output can therefore retain other history indefinitely. Compact output/attempt/push
references impose no document hold.

The durable `contractCleanups` marker enters `waitingDocuments`, clears its active job
and parks with an hourly indexed recovery hint while a full owner remains. Final full
owner replacement/deletion wakes it in the same transaction. Waiting recovery checks
at most ten indexed markers under the caller's shared budget. New output/document
acquisition and drain consult the same live root/marker transactionally; after root
deletion no new owner can be acquired. Existing unresolved work may settle/release
without reopening drain.

At zero full owners, generation-fenced cleanup drains **all remaining manifests
first**, then the entire contract chunk range, and removes its marker only at an
empty range. Each drain turn rechecks the indexed full-owner gate. A shared chunk is
never deleted merely because one output expired; final reclamation needs no company
deletion. The old sticky `retainedAfterDeletion` field/index/reserves are absent.

Account erasure selectively retires private actor-owned preparation while keeping
company evidence/canonical fences. Company erasure owns the full local tenant set:
operation/output owners and sections, attempts, provider state and documents share
one cleanup budget with final catch-up for children and already-advanced markers.
Erasure ends local retention without asserting an external provider outcome or
deleting previously written provider records.

## Indexed collection and recovery

The hourly `retentionMaintenance.pump` owns one global `retentionSweeps` row, with no
tenant payload or execution authority. A cycle captures one timestamp and keeps it
across `operations`, `creations`, `discussions` and `outputs` phases. Discovery uses
`by_gcAfter` or `by_retentionDueAt`; each scheduled turn reads one indexed candidate
with one-row/1,100,000-byte read bounds and invokes at most one nested owner mutation.
The caller reserves 4 MB each of reads/writes, 64 queries/read documents/written
documents, two scheduler slots and 2,048 scheduled-argument bytes for durable progress.
Receipt/output proof disposal removes at most eight fragments in an owner turn.

Held, pending and failed owner turns all advance traversal. Nested failure rolls back
that owner while the parent logs the failure and preserves cursor/version/job progress.
Each owner gets at most one turn per cycle; large drains may need multiple hourly
cycles after eligibility. Failed/missing/canceled callbacks recover the same
cutoff/cursor with a new version; stale/duplicate versions do nothing. No hold causes
a hot retry loop or moves a business deadline. Physical reclamation is eventual,
subject to scheduler progress and legitimate holds, rather than immediate at expiry.

Operation disposal checks the original immutable identity/deadlines, retires private
work, verifies no private output backlink remains, and waits for exact native disposal
readiness. Staged email snapshots transfer to an independent complete delivery owner
or finish real disposal before their receipt can disappear. Replay drainage then
marks the receipt `collecting`, removes bounded payload fragments and deletes the
receipt only at an empty section range. Collecting replay returns explicit expiry;
it never decodes partial payloads. Creation/discussion collection removes only replay
receipts, without deleting business history or making an old identity executable.

## Verification and release limits

Existing export/provider/performance fixtures retain their cost, byte, approval,
delivery and replay assertions. Current type/static checks establish schema/caller
coherence; executed assertions and pending validation are recorded in package results.
See [performance checks](performance-checks.md) for suite boundaries. The existing
suite does not prove the complete native-promotion/hold/compaction/deletion race matrix,
populated hourly fairness, exact time boundaries, physical platform consumption or
actual external provider outcomes. No new coverage or browser automation was added.

A populated release uses the concrete [outside-repository preservation kit and exact G01–G25 gates](backend-preservation-cutover.md). All live gates remain UNVERIFIED. It still requires factual data/file/job inventory, preservation,
ready indexes, writer/callback quiescence and explicit owner/marker/deadline conversion.
Missing history, unknown live populations and queued old work remain release gates;
no source edit supplies those facts. Follow the separately maintained
[release procedure](deployment.md#backend-ownership-conversion); this document
authorizes no conversion, deployment, provider action or data loss.
