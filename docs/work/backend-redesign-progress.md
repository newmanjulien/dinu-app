# Backend redesign progress

Scope: implement the approved ten-step backend redesign. Preserve durable IDs,
pending browser operations, existing product behavior, and unrelated workspace
changes. Local implementation only; no deployment or live-data changes yet.

## Ownership and target

- Core: generic operation receipts; contract identity and working state; captured
  templates; immutable proposal definitions; buyer release; export attempts.
- Integrations: active HubSpot association and captured export delivery; existing
  provider-specific booking, email, and CRM state machines.
- Maintenance: bounded, resumable conversion and lifetime-specific cleanup.
- Keep physical contract, proposal, and export IDs. Keep distinct revision clocks,
  permanent buyer links, latest-only buyer release, and template copy-on-write.

## Workstreams

- Contract storage agent: root/working/association split, explicit aggregate,
  centralized readers/writers and buyer access.
- Proposal model agent: native immutable definitions, canonical resolved model,
  backend/frontend consumers and legacy conversion.
- Core operations agent: generic receipts, core export ownership, provider child,
  legacy routes and retention/cleanup boundaries.
- Main: template lifecycle enforcement, booking state evidence, coordinated
  migration/cleanup, documentation, integration and final verification.

## Evidence and constraints

- Read `AGENTS.md`, generated Convex guidelines, Convex expert/design skills.
- Existing uncommitted changes were present before implementation; preserve them.
- Pending draft namespace `dinu:drafts:v4` and payloads 4/5/6 must stay recoverable.
- Export acknowledgement journals have no age cutoff. Retain the physical
  `hubspotExports` ID and old acknowledgement route indefinitely.
- Generic receipts and export attempt metadata outlive individual contracts.
- Frozen templates cannot be rewritten, even if a body retains mutableVersionId.
- No new tests or browser automation. Maintain necessary existing fixtures.
- Required: perf suite for changed saving/scheduling/caching; backend TypeScript;
  necessary lifecycle/HubSpot suites and final `npm run verify`.

## Completed

- Implementation authorized by user (“go”).
- Read-only planning completed before this implementation.
- Work divided by domain with shared-schema sections assigned explicitly.
- Canonical contract root/working/active-association ownership, explicit aggregate,
  compatible readers, centralized writer and synchronous association release.
- Core receipt/chunk ownership with exact legacy replay, validated chunk ownership
  and ordering, bounded atomic conversion and retirement status.
- Native proposal definitions and canonical semantic consumers; provenance folds
  into the unchanged immutable definition ID without fabricated authoring fields.
- Core exports, preserved physical IDs/legacy routes, provider delivery child and
  independent metadata/file/provider lifetimes. Late acknowledgements use captures.
- Central mutable-body ownership guard, frozen capture readers and authoritative
  manifest generations, retaining copy-on-write and incremental capacity paths.
- Format-2 booking union with required terminal evidence. Conversion leaves
  unverifiable legacy observations unknown and fences unsafe new attempts.
- Company/contract cleanup covers new owners and old workers already past newly
  added phases; core/provider company drains share one transaction budget.
- Bounded conversion and read-only retirement endpoints for all changed owners.
  Existing architecture/storage/release docs describe authorities and rollout.
- Existing perf/integration/viewer fixtures maintained. No new tests/coverage or
  browser automation; approved copy feedback path remains intact.

## Verification and remaining gates

- Backend TypeScript passed after integration; final pass log:
  `/tmp/backend-redesign-tsc-final.log`.
- Frontend/Svelte/tools checks and production build passed:
  `/tmp/backend-redesign-build.log`.
- Performance suite passed 37/37 before final review; final pass:
  `/tmp/backend-redesign-perf-final.log`. Guarantees retain no-op/replay no-write
  behavior, selective reads/compilation, bounded caching and authoring rollback.
- HubSpot suite passed 60/60; final pass:
  `/tmp/backend-redesign-hubspot-final.log`. Existing assertions retain replay,
  captured destination/actor, upload retention and late acknowledgement behavior.
- Loading-bundle verification passed: `/tmp/backend-redesign-bundles.log`.
- Full `npm run verify` stops at three SSR loading failures:
  `/tmp/backend-redesign-verify.log`. The separate client lifecycle run has
  84/92 passing: `/tmp/backend-redesign-lifecycle-client.log`. Failures concern
  loading-skeleton params/role expectations, static buyer header, missing setup
  prompt context and existing buyer-link retry/request expectations. Their UI
  paths already had separate workspace changes; they were not rewritten or their
  assertions weakened for this backend task.
- No deployment, live conversion, reset or schema retirement performed. Snapshot
  rehearsal, native limits/concurrency, real providers and browser acceptance
  remain unverified. See `docs/deployment.md#backend-ownership-conversion`.
- Before release, resolve the workspace UI verification failures and execute the
  explicitly authorized snapshot rehearsal/rollout gates. Keep compatibility
  branches until every retirement check and old-client/action gate is satisfied.

## Proposal domain checkpoint

- Native immutable definitions now own choice identity, normalized proposal text,
  the complete inherited change envelope, primary-change/prefix metadata and
  thread/message-revision provenance. New applications deduplicate on the
  definition index and create no `proposalApplications` rows.
- Shared resolved items expose `origin`, `primary`, `review` and `choices`.
  Proposal choices have no fabricated tier, instructions or authoring trigger.
  Template-only guidance remains under template origin; document geometry uses
  a rendering projection of the primary annotation.
- Contract readers, saving/review/publication/discussion flows, seller document
  state and buyer release/download consumers now use the resolved semantics.
  Buyer DTOs contain only released choice changes and primary geometry.
- `contractDefinitions.backfillProposals` converts receipt-backed legacy rows in
  place, preserving IDs, then deletes the redundant provenance receipt.
  `retirementPage` must show no legacy definition on every page and no receipts
  before removing the compatibility branch. These functions have not run live.
- Type-check checkpoints: `/tmp/proposal-check2.log`; outstanding errors at that
  checkpoint were mainly parallel work and fixture adaptation. No deployment,
  browser checks, new tests or live migration performed.
