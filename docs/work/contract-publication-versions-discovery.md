# Contract publication and versions — discovery

## Scope and stage

Initial request: understand the app, ask product questions, then propose a
high-level redesign/architecture. User has now explicitly invoked `plan-refine`
to prepare an implementation plan through planner, evaluator, and reviser stages.
Planning only; no implementation authorized at this stage.
Preserve existing workspace changes. Source inspection only; no deployments,
browser checks, or tests required at this stage.

## Confirmed intent

- Add `Publish to buyer` at the bottom of the seller-side buyer link.
- Admin approval changes internal wording, but buyer wording changes only through
  explicit seller publication.
- Pending or declined submitted changes prevent publication.
- Each publication creates a contract version; negotiation records belong to a
  version. Internal views default to the latest; buyers may be behind.
- All user types can navigate permitted older versions. Show a version tool in the
  left rail when more than one version is available.
- Prefer a clean, simple final model; migration churn is not a design constraint.

## Existing architecture and evidence

- `src/convex/contractValidators.ts`: `savedContracts` owns stable identity, frozen
  template reference, title/buyer; `contractWorkingState` owns applications and
  concurrency/review counters. These counters are not contract versions.
- `src/convex/schema.ts:261`: immutable template versions/revisions already exist;
  these are company template snapshots, not negotiation/publication versions.
- `src/convex/contractPublication.ts:59`: one mutable `contractBuyerState` per
  contract. `publishContract` incrementally releases eligible selections and
  preserves prior wording for blocked overlapping changes; no publication history.
- `src/convex/contractSaving.ts:185`, `contractApprovals.ts:270`, and
  `contracts.ts:187`: saves, approvals, and rename invoke automatic publication.
- `src/convex/buyerChangeState.ts:119`, `buyerChangeApprovals.ts:83`, and
  `discussionProposals.ts`: accepted buyer proposals have a separate approval
  workflow. Approved proposal changes are composed dynamically into both internal
  and public wording; changes bump buyer revision without explicit publication.
- `src/convex/contractReader.ts:112`: effective wording reads all active approved
  contract-local proposals unless exact effect IDs are provided. Historical reads
  must never resolve against mutable current approvals or active flags.
- `src/lib/buyer/BuyerShell.svelte`, `contract.svelte.ts`, `seller.svelte.ts`:
  seller recognition adds private chrome/review controls to the same anonymously
  acquired public document. `View as buyer` is currently chiefly an interaction
  policy switch, not a separate document selection.
- `src/convex/discussionValidators.ts`, `discussions.ts:34` and `:56`: discussions
  belong to contract IDs; token and membership reads share them. No version or
  unpublished-thread visibility boundary exists today.
- `src/lib/discussions/validators.ts`: discussion anchors can target source text
  or particular replacement effects, so preserving text alone is insufficient to
  reproduce old annotations/accepted proposals.
- `src/convex/documentExport.ts`: internal Word/HubSpot quote generation requires
  approved selected dashboard concessions. Export attempts freeze exact proposal
  IDs; buyer download separately uses current `buyerRevision` and rejects stale
  revision requests (`src/routes/api/buyer/[token]/download/+server.ts`).
- `src/lib/contract/draft-values.ts`, `editors.svelte.ts`, `snapshot-cache.ts`:
  editor/draft state is keyed around contract identity; template snapshot caching
  is already immutable. Version selection must isolate mutable drafts and retained
  operations without duplicating template source data.
- Buyer activity, unread badges, approval emails/completion, HubSpot events and
  deliveries, retry receipts, deletion/cleanup also currently use contract identity.
- Seller identity uses Clerk verified identity and company membership; buyers use
  the stable bearer link plus server-managed browser identity for discussion writes.

## Questions sent to user

1. Publish then share the new version until next edits, or immediately open the
   next internal draft after publishing?
2. Do discussions close when superseded, or can old published versions still
   receive comments/replies?
3. Initial buyer visibility before the first publication?
4. Can declined submissions be removed/withdrawn to unblock publication?
5. Does the approval/publication gate cover accepted buyer proposals too; do
   untouched proposals block it?
6. Carry previously approved wording forward without reapproval, leaving prior
   discussion/decision records with their original version?
7. Which team members can publish?
8. Are unpublished seller comments hidden until publication as well?
9. Do internal downloads/HubSpot exports use unpublished approved or published text?

Working assumptions, explicitly shared for correction: stable buyer URL; buyer
history contains only published versions; older contract text cannot be edited.

## Answers received

- Link creation establishes buyer-visible V1, including concessions approved
  before the link existed. First explicit publication creates V2, then V3, etc.
- Declined submissions can be withdrawn/removed to unblock publication; history
  does not block forever.
- Accepted buyer proposals require approval AND publication. Untouched proposals
  behave as comments and do not block publication.
- Previously approved wording carries forward without reapproval. Comments and
  decision history remain with their original version.
- Any team rep/admin can publish.
- Comments are version-bound; seller must switch to the buyer's version to have
  a discussion there.
- Only the latest published version may be downloaded or pushed to HubSpot,
  including from seller views. Unpublished wording cannot be exported.

## Follow-up answers received

- Seller must navigate to buyer-current V1 to leave buyer-visible comments while
  internal work is ahead. Discussion follows selected version, not author role.
- Historical versions are read-only unless they are still the version the buyer
  is on. Thus buyer-current published V1 remains open while internal draft is ahead;
  it closes for discussion when V2 replaces it as buyer-current.
- Accepting a proposal from buyer-current V1 creates the approval request in the
  latest internal draft, provided the relevant wording still matches. Explicitly
  block conflicting applications. Originating discussion stays on V1.
- Initial V1 includes concessions approved before link creation.
- During plan refinement, user explicitly confirmed seller-side buyer link shows
  only approved wording while pending/declined candidate changes stay visible in
  the dashboard for review. Same owning version has distinct candidate and
  approved presentation projections; buyer publication remains a separate gate.

## Design implications already established

- Exports need a shared published-content boundary across public Word download,
  seller Word generation, and HubSpot native quote pushes; approval alone no
  longer determines export eligibility.
- Discussion version and target draft version can differ when accepting an older
  buyer proposal. Exact originating text/revision must remain traceable; never
  silently apply against changed wording.
- Public content cannot compose through current active approval rows. A published
  version must pin complete content inputs and preserve anchoring identities.
- Latest internal version, latest published version, explicitly selected history,
  approval counters, and edit concurrency counters are distinct concerns.
- Version-scoped negotiation records do not imply duplicating stable contract,
  template, member, buyer, link, or visitor identity on every publication.

## High-level proposal

These are proposed architecture choices, distinct from confirmed answers above:

- One stable contract/link identity, immutable published versions, and one shared
  internal working draft. Draft has a stable workspace identity before receiving
  its publication number; do not use edit counters as public version numbers.
- Link creation publishes V1; internal work uses Draft for V2. Publish seals that
  workspace as V2 and opens a fresh Draft for V3 from its approved wording.
  This follows the user's rule that internal views share the latest working
  version while buyers remain on the latest publication.
- Discussions/requests/decisions remain on the workspace/version that owns them.
  Draft-for-V2 comments would become V2 discussions when V2 is published; approval
  records remain private. New Draft for V3 inherits wording/provenance, not copies
  of V2 discussions, submissions, or decision history. Explain this interpretation
  explicitly in proposal rather than silently assuming comment visibility.
- Version navigator exposes draft + published history to sellers, only published
  history to buyers. Seller navigation is needed even with only V1 published so
  they can switch from internal draft to buyer-current V1 for discussion.
- Consider initial link creation an initial publication with the same approval
  gate; this avoids a different partial-release model before V1. This is a proposed
  product rule (pending first-link work was not explicitly decided by user).
- Publication is atomic, idempotent, revision-checked, and whole-document. Pending
  or declined active submissions block; withdrawals and unaccepted buyer proposals
  do not. Published baseline wording carries forward without repeated approval.
- Immutable content inputs include effective concession/proposal definitions and
  anchor provenance, reusing immutable template snapshots. Historical reads never
  compose against current mutable acceptance/approval rows.
- Resolve document context centrally by audience + selected version, then derive
  text, discussions, permissions, review state, and export target consistently.
- Version-bound saves, drafts, retries, notifications, and asynchronous deliveries
  cannot silently retarget newer work. Existing edit/review counters remain only
  concurrency controls within the owning workspace/version.
- All export paths use latest published version, independent of pending work.
  Before first link/V1, proposed behavior is exports unavailable.
- Published wording is immutable; discussion on the buyer-current publication
  remains writable. Superseded publications are entirely read-only. Changing
  inherited approved wording is new work subject to the applicable approval policy.

## Next

High-level proposal delivered. All three sequential `plan-refine` stages completed
with fresh contexts. Final standalone plan:
`docs/work/contract-publication-versions-plan.md`. Internal handoffs remain outside
the repository in `/tmp/contract-version-plan.SG4XZU/`.
No app files changed; no tests/build/browser/deploy/backend operations performed.
Await user approval to implement the final plan, as required by the invoked skill.

Additional clarification answered: seller-side buyer link shows only approved
wording. Current dashboard composes all selected applications, whereas current
seller buyer-link content uses the approved released projection. Same owning
version does not imply identical review-stage projections. Final plan incorporates
the candidate-versus-approved distinction across state, composition and ownership.

Material evaluator finding: retain draft-owned last-approved effective content,
separate from both candidate applications and last published content. Example:
published A; unpublished B approved; replacement C pending/declined. Seller must
continue seeing B, which cannot be reconstructed from published A + candidate C.
Existing partial-release dependency handling may remain internally as approved
projection logic; only buyer release becomes exclusively explicit/atomic. Final
resolver/cache/discussion/proposal contexts distinguish projection revision inside
a version as well as version ID. This correction is included in the final plan.
