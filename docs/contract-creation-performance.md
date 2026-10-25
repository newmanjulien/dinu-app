# Contract creation preparation and immutable templates

New contracts reference the current published template. The naming screen prepares
the actual viewer, then adopts that viewer after the server confirms creation.
Company names do not affect layout. There is no optimistic saved contract or draft
in persistent caches.

## Storage and publication

`templates.publishTemplate` captures and validates the complete live template and
publishes version metadata, version-owned blocks and items, and the indexed current
pointer in the same transaction as an admin save or deletion. Instruction changes
publish too. Replayed operations and missing-item deletions publish nothing.
Publication preserves original Playbook Item IDs and indexed selected-item lookup.
The complete snapshot must satisfy existing semantic checks, supported row counts,
and the 8 MB UTF-8 bound. Remaining transaction write/query capacity is checked
before copying and once before updating the pointer; a failure rolls back both
authoring and publication. Publication serializes the snapshot once for sizing.

Version content is immutable and retained indefinitely in this release. Storage
therefore grows with each successful template save, including instruction-only
saves. The measured template contains 113 blocks and 56 items: each publication
adds 169 content rows plus version metadata. Garbage collection is deferred.

Every saved contract requires a published template version. Shared helpers validate
the version's company before loading complete snapshots, blocks, or indexed selected
items. Version metadata owns completeness counts; saved contracts only reference
their version. Saving, approval validation, and approval descriptions use these helpers.
Contract deletion removes the contract and its approval work, never the shared version.
The fresh development reset retired per-contract snapshot tables and snapshot hashes.

Memory and IndexedDB caches retain immutable content once per template version,
with separate metadata per contract. Both retain the 24-contract and 32 MB limits;
byte limits count shared content once, and metadata updates preserve snapshot identity.
IndexedDB upgrades rebuild only the optional snapshot cache, leaving draft journals intact.

Creation checks its retry receipt before the current pointer and version metadata,
then inserts exactly the contract, receipt, and compact contract-directory entry.
It does not read or compile template
content. The response includes authoritative contract metadata, version ID, revision,
and confirmed initial choices. Retries keep the original contract/version; a receipt
for a deleted contract returns `deleted`.

## Viewer handoff

The naming screen subscribes to the current published template and preloads saved
route code concurrently. One protected, inert draft resource prepares the document
using the existing progressive renderer and scheduler. Its stable owner and object
identify the viewer independently of its changing route association. Drafts count
against retention budgets and remain protected while the naming screen owns them.

After confirmation, a matching template seeds the snapshot cache with the same
snapshot references and explicitly adopts the resource before navigation. Its
workspace, viewer, renderer, wrapper, and page elements survive. A mismatch loads
only the server-returned immutable version and pins it for the opening; subsequent
admin publication cannot replace it.

One live contract-state subscription reconciles newer revisions and deletion before
revealing the page or enabling interactions. Cache seeding preserves newer revisions
and cannot revive a deleted contract. Bindings and ownership transfer during route
navigation. Cleanup destroys an unadopted draft; an adopted resource survives.
Opening errors retain the created ID, so Retry opens that contract without another
Create mutation. Cancellation adds neither a persistent draft nor opening history.
With `PUBLIC_CONTRACT_DOCUMENT_PREPARATION=0`, the ordinary progressive viewer uses
the confirmed snapshot directly.

## Development measurements

Measurements were taken on 2026-10-07 against personal development deployment
`scrupulous-squirrel-986`, using the same Chrome 154 profile, 1440 × 1000 viewport,
Vite development app, source template (113 blocks / 56 items), and unthrottled network
and CPU. Each implementation was measured with 20 prepared and 20 immediate-submit
openings. Prepared trials waited four seconds on the naming screen; cold trials
submitted as soon as its input appeared. “Cold” means immediate submission, not an
empty browser cache. These are sequential samples, not randomized production trials.

Bounded local timing marks record numbers and preparation status only, never company
names, contract IDs, or document text. They are enabled in development, or with
`PUBLIC_CONTRACT_PERF=1`, and retain at most 100 traces. Mutation timing includes
transport and client scheduling. The display marker follows the first visible-page
callback, route completion, and naming-dialog reveal; it is not a pixel rasterization
measurement. CDP network events and runtime counters were inspected separately.

All values are milliseconds, shown as p50 / p95 using nearest-rank percentiles,
rounded to whole milliseconds. Each row contains 20 openings.

| Flow                         | Samples | Create mutation | Confirmation → display | Click → display |
| ---------------------------- | ------: | --------------: | ---------------------: | --------------: |
| Baseline prepared            |      20 |       383 / 563 |             960 / 1471 |     1522 / 1949 |
| Baseline immediate submit    |      20 |      769 / 1140 |              335 / 466 |     1128 / 1579 |
| Implemented prepared         |      20 |        75 / 222 |              135 / 203 |       210 / 353 |
| Implemented immediate submit |      20 |       207 / 279 |              104 / 146 |       307 / 419 |

The prepared median click-to-display decreased by **86%** (1,522 → 210 ms).
Confirmation-to-display decreased by **86%** (960 → 135 ms). Immediate-submit median
click-to-display decreased from 1,128 to 307 ms. Mutation round trips also varied
substantially across sequential runs; these observations do not isolate server time
or establish a production latency guarantee. Automated checks establish the constant
creation work and browser inspection establishes reuse of the prepared document.

The baseline separates route navigation, subsequent snapshot retrieval, and render
reveal. The implemented flow confirms and adopts its local snapshot before navigation;
its final reveal phase includes waiting for the live state subscription. Those phases
have different boundaries and should not be treated as equivalent backend timings.

| Flow                         | Navigation | Baseline retrieval / implemented local handoff | Baseline render / implemented state-confirmed reveal |
| ---------------------------- | ---------: | ---------------------------------------------: | ---------------------------------------------------: |
| Baseline prepared            |    25 / 33 |                                     884 / 1389 |                                              55 / 85 |
| Baseline immediate submit    |      6 / 9 |                                      293 / 416 |                                              39 / 47 |
| Implemented prepared         |    40 / 53 |                                          5 / 7 |                                             82 / 155 |
| Implemented immediate submit |    25 / 30 |                                         4 / 11 |                                             73 / 113 |

Instruction-only admin saves now include full publication. Six development browser
mutation round trips measured p50 **232 ms** and p95 **729 ms**, using nearest-rank
percentiles. This small sample includes network time and is not a publication SLA.

The numeric samples are retained in
[baseline](performance/contract-creation-baseline.json) and
[implemented flow](performance/contract-creation-optimized.json).

## Verification evidence and limits

Automated regression checks cover initialization idempotence/concurrency and its
race with admin publication; immutable old content; publication replay/no-op behavior;
rollback after partial copying and invalid-template rejection; latest-version
creation, retries, and deleted receipts; two contract/receipt writes plus one compact
directory write with no content reads;
saved versions after live-item deletion; saving and approval description reads; import maintenance;
exact-reference cache seeding, newer revision reconciliation, and deletion protection.
External email delivery is stubbed. Existing save, scheduling, rendering, and cache
performance assertions remain in place.

Chrome CDP observations checked a matching prepared opening for identical page and
wrapper objects, no additional composition/pagination/page mounts, no follow-up
snapshot request, and one live state subscription. Additional browser scenarios
checked immediate submission, live template updates while naming, version mismatch
and pinning, newer saved selections before confirmation, injected navigation/render
failures followed by retry, deletion during opening, cancellation, synthetic font
invalidation, and disabled retention. The font check exercises the browser font
invalidation event path; real delayed font delivery was not separately measured.
Capacity rejection is tested with transaction metrics, not by exhausting a live
production transaction. SMTP delivery and production performance remain unverified.
A first-use help dialog can overlap the document; measurements concern the document
viewer and naming-dialog handoff.

Final local checks passed: `npm run verify` (22 tests across four files, zero Svelte
errors or warnings, and production build), Convex TypeScript checking,
`npm run seed:verify` (58 compositor states and zero reconciliation mismatches),
changed-file Prettier checking, and `git diff --check`.

## Initial imports

New contracts reference a published immutable template version. Initial imports use
`npm run convex:seed -- --company-id COMPANY_ID` on a configured development/local
deployment. The scoped `companyTemplateImport` workflow fingerprints business
content, persists batch counts, verifies the committed prefix, and publishes through
`finish`. It resumes interrupted imports without overwriting edited content or
republishing an unchanged completed import. Items receive revision 1 and immutable
heads from the shared authoring writer.

Imports block creation and authoring until publication completes. After the
[fresh reset](private-companies-rollout.md#fresh-development-reset), create the
account/company through normal onboarding, seed the actual company ID, and audit
before intentional edits. Local checks do not certify a deployment or live seed run.
