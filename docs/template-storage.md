# Template storage

Each company has one permanent baseline. Its ordered blocks are shared by every
published template version. A version holds a complete rule-ID-to-revision manifest;
immutable revisions retain historical content and authoring metadata, excluding the
revision head. Authoring records keep stable rule IDs, required revision counters,
and operation receipts. Save and Delete publish immediately and atomically through
the existing interface.

Admin saves and seed append share revision creation. New rules start at revision 1;
updates advance the counter and create one immutable revision. Publication validates
one captured playbook, writes its complete manifest, and advances the pointer.
It never repairs heads or rereads live content. Deleting a live rule retains its
historical revisions and manifests until company deletion.

## Read boundary

`savedContracts.state` returns the live contract metadata, including its immutable
`templateVersionId`. `templates.current` returns only the current version ID;
`templates.version` authenticates the membership and resolves immutable content.
There is no full-contract snapshot query or SvelteKit snapshot proxy.

The browser cache shares pending version reads, immutable object identity, and
stored versions across new-contract previews, creation handoff, opening, and
prewarming. Cancelling one reader does not cancel a shared read with other consumers.
Memory retains at most 24 contract entries and 24 versions within a combined 32 MiB
budget. Optional IndexedDB reads have a short deadline and fall through to Convex;
confirmed state writes do not rewrite immutable content. Each contract route still
waits for fresh live metadata before accepting a cached document.
Malformed versions are removed in their validation transaction so a verified
network read can repair them. Invalid metadata is removed without discarding valid
shared content. Identity setup clears obsolete v1/v2 caches, including stored versions.

Word generation captures a full immutable snapshot and saved selections on the
server only when requested. It rejects unavailable concessions, pending/rejected
required reviews, stale revisions, deleted contracts, and invalid membership.
After generation and storage, a final mutation rechecks access, revision, version,
and the captured required approval lifecycles, then issues the URL and schedules
cleanup atomically. Review decisions can change without advancing the content revision.
Temporary files are removed after one hour, including abandoned downloads. Access
is enforced when issuing the URL; an already issued URL retains its existing lifetime.

## Supported envelope

A playbook supports at most 4,000 rules and an 8,000,000-byte historical JSON
snapshot. Existing baseline limits remain in place. Full readers resolve revisions
in batches of 64: 4,000 revision lookups leave 96 native queries for manifests,
baseline, authorization, and other parent reads. Selected reads retain their
1,024-selection limit and concession validation. Full, selected, and approval
reads use the same manifest/revision ownership checks.

Publication measures stored documents with Convex's document-size helper.
Each write group checks the remaining transaction budget after preceding work;
queries, documents, and bytes are accounted separately. Checks
reserve two metadata writes and 64 KiB beyond explicitly counted work. Read capacity
includes revision and manifest wrappers and baseline metadata. A rejection rolls
back authoring, revisions, receipts, manifest, version, and pointer together.

Save/Delete validate and manifest the whole playbook. Their work scales with its
complete size within this envelope.

## Upload and deletion operations

An upload authenticates, checks company eligibility, receives at most 10 MiB, and
hashes accepted chunks incrementally, without assembling another flat buffer.
An authoritative reuse transaction matches company, uploader,
file hash, parser version, and expiration before another copy is stored or parsed.
New originals are stored and parsed in an internal Node action; the committing
mutation rechecks permissions, eligibility, file metadata/hash, diagnostics, and
canonical blocks. Cleanup is dispatched separately and checks references again;
cleanup or dispatch failure does not change a successful preparation response.

Prepared DOCX uploads expire after 24 hours. Scheduled cleanup and recurring sweeps
remove their blocks and originals. At 04:00 UTC a bounded creation-time-index scan
removes old unreferenced DOCX files. A durable cursor and fixed cutoff resume an
interrupted sweep; its completed creation-time watermark excludes previously
scanned intervals. Duplicate continuations do no work. Published originals are
retained until company deletion.

Operator audits and seed reconciliation read business projections through
`companyTemplateImport:readPage`. Initial seed imports retain their content
fingerprint and committed counters for resumption; existing template data prevents
replacement. Company deletion drains baseline blocks, immutable revisions,
manifests, prepared uploads, and retained originals in bounded batches.

## Reset and reseed

The schema accepts only canonical records. Use the
[fresh reset procedure](private-companies-rollout.md#fresh-development-reset)
before deploying over incompatible data. There are no runtime conversion workers,
copied version blocks, inline manifest payloads, or revision fingerprint indexes.
The original archive and its independent output oracle remain offline seed inputs.

## Verification

`npm run verify` runs the existing 24 performance checks, frontend types, and
production build. Backend TypeScript is checked separately. The maintained rollback
fixture checks changed-rule revision creation and partial publication rollback.
`npm run seed:verify` checks 56 mutation/business-field round trips and 58 output
states, including source/token provenance, against the independent historical oracle.

A local export smoke check generated and inspected Word content, rejected stale
revisions and unauthorized callers, checked pending/rejected reviews and revocation
without a revision change, and verified scheduled cleanup and file removal.

After this cleanup, temporary probes exercised the actual export action with
contract deletion, revoked membership, revision changes, review changes, lifecycle
replacement, and version deletion during file storage. Delivery was refused and
failed files removed; a cleanup failure preserved the original error. Cache probes
checked atomic malformed-version removal and repair, metadata-only removal,
shared-version deduplication, cancelled reads, and obsolete-cache cleanup without
an identity change. Upload probes checked chunked 10 MiB byte/hash equality and
oversize rejection. Sweep probes checked bounded pages, cron resumption, stale
continuations, referenced originals, watermark advancement, and equal timestamps
across page boundaries. These probes were not added to the repository test suite.

The development schema was deployed and its database reset/reseeded during the
server split. This cleanup also deployed successfully to
`dev:scrupulous-squirrel-986` without another reset or reseed.
Import interruption/resumption, live HTTP authentication,
concurrent uploads, browser behavior, and adversarial parser memory bounds are not
certified by these local checks. No new repository tests or browser harness were added.
