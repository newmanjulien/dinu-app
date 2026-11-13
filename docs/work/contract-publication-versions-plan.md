# Contract publication and version-scoped negotiation plan

Historical work log. Its draft/successor and publication-based seller-export model is superseded by [the current data model](../data-model.md), [lifecycle](../lifecycle.md) and [retained rollout gates](../deployment.md#backend-ownership-conversion). This log is not a deployment or conversion certificate.

**Status: proposed; implementation requires approval.** This plan preserves existing workspace changes. No application changes, tests, build, browser checks, deployments or backend data operations were performed while preparing it.

Keep one stable contract and buyer URL, one shared latest internal draft, and numbered publications with immutable wording. Creating the first buyer link establishes V1, including concessions approved before the link existed. The first explicit `Publish to buyer` creates V2. Admin approval changes approved internal wording; only publication changes buyer wording. Any team rep or admin may publish, without gaining additional approval authority.

## 1. Model versions and their explicit content projections

Introduce `contractVersions` through `src/convex/schema.ts`, `contractValidators.ts`, `buyerValidators.ts` and `contractState.ts`. Keep company/contract ownership, lifecycle, immutable template reference, title, baseline publication, and applicable concurrency state on each version. The stable contract owns latest-draft/latest-publication pointers and retains link, buyer identity, memberships and HubSpot association. Initial contract setup creates the draft pointer; publication advances both pointers. Template versions and edit/review counters remain separate from public contract version numbers.

A draft needs two content projections, independent of the buyer publication:

| Context         | Content                                                                                          | Intended surface                           |
| --------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Draft candidate | Current saved applications, including pending or declined submissions, plus their review context | Internal dashboard                         |
| Draft approved  | Last approved effective wording, retained while replacements await approval or are declined      | Seller-side buyer link                     |
| Publication     | Exact effective content frozen at publication                                                    | Buyers, published history and every export |

For example, V1 contains A. In Draft V2, approving B makes the seller-side buyer link show B while the buyer still sees A. Replacing B with pending or declined C makes the dashboard show C, the seller view retain B, and the buyer retain A. Neither filtering current applications nor composing them over V1 can recover B. Store the draft's approved effective state explicitly; approval audit records are not a substitute for that document state.

Use one bounded content representation for draft-approved and published effective inputs. Pin exact selections, replacement definitions, suppression, item/effect identities, source dependencies, proposal origins and anchor provenance. Reuse immutable template blocks. Use indexed child storage where needed for document/read/response limits; do not put growing history arrays on the root, reconstruct publications through a chain of earlier drafts, or resolve them through today's active approved requests. A sealed publication retains its own negotiation records and frozen inputs even when later request statuses or source discussions change.

The proposed lifecycle is to seal the existing draft row as the next publication and immediately create its successor from the sealed approved content. The successor inherits wording and server-owned approval provenance, without copying comments, submissions or decisions. This avoids moving discussions between version identities.

## 2. Centralize authorized document context

Create one resolver used by document content/definitions, reviews, discussions and export targeting. Resolve audience, stable contract/token, optional selected version, and explicit projection into an authorized version, content revision/inputs, latest identities and capabilities. The dashboard and seller buyer-link view default to the same latest internal version, with candidate and approved projections respectively. A publication has one frozen content context.

Authenticated members can select their contract's draft or published history. Buyers can select only published versions through the stable token and default to latest published. Lists are indexed, bounded and paginated. Validate company, contract and version ownership for every supplied identifier. Token DTOs expose no draft metadata, pending wording, approval history or private instructions. Private draft reads and writes require authenticated transport; recognizing a teammate must not grant draft access through the anonymous content API.

Carry version, projection and relevant content revision through composition, complete-input readiness, prepared/retained document identity, selections, annotations, cache keys and action validation. Template caches still share by immutable template-version ID. Keep discussion history owned by version, rather than creating separate discussion histories for candidate and approved views. Anchors additionally identify the exact content/projection they were created against. Preserve an unavailable passage as historical context when draft wording changes; never silently remap it to incompatible wording or another version. Review actions identify the actual target application/request rather than treating approved preview B as candidate C.

## 3. Make saving and approval advance only the owning draft

Update `contracts.ts`, `contractSaving.ts`, `contractApprovals.ts`, `reviews.ts`, `contractDefinitions.ts`, `buyerChangeState.ts`, `buyerChangeApprovals.ts`, shared approval helpers and validators. Every save, application, request, decision and completion identifies its owning version. Scope operation fingerprints and indexes accordingly. Content/review mutations require that version to remain the latest draft. Authorized teammates may read historical private review records without reopening them.

Adapt the useful dependency-aware advancement in today's `contractPublication.publishContract` into internal draft approval advancement. It currently preserves previously released wording while overlapping replacements are blocked. Preserve that guarantee for the draft-approved projection, including previously approved proposal effects and exact suppression/dependency identities. Remove its ability to advance buyer wording. Eligible internal changes can advance approved draft content; a blocked replacement retains the preceding approved content for its affected dependency group. Keep the candidate applications separately available for review.

Inherited approved wording needs server-owned baseline approval provenance. Starting an empty successor review history must not make inherited required-approval concessions pending again: `savedReviews` currently interprets missing approval as pending. Changed inherited wording creates new draft-owned work under the existing approval policy, without editing old decisions. Keep current server-derived admin authorization and admin auto-approval behavior.

Make cancellation and removal distinct:

- Withdrawing a pending/declined replacement cancels that active submission and restores its preceding approved state, without reapproval. Retain the submitted wording and decisions in history.
- Deliberately removing or reverting already-approved wording is an explicit content operation under the applicable approval policy. Do not infer that intent merely because an application entry disappeared.
- Removing a new unapproved concession with no approved predecessor cancels it. Withdrawn or otherwise inactive requests cease to block publication.

Extend accepted-proposal undo to declined active requests; `discussionProposals.undo` currently allows only pending ones. Approval or withdrawal updates only the target draft's candidate/review/approved state. Remove buyer-publication revision updates from `touchBuyerReview`. Approved content and decisions must survive later candidate replacements; publication freezes the resulting approved effective content after all active blockers are resolved.

## 4. Implement atomic, explicit publication

Replace automatic buyer release in `contractPublication.ts` with a whole-document eligibility calculation and publication mutation shared by first-link creation and `Publish to buyer`.

Active pending or declined required-approval submissions, concessions and accepted buyer-proposal requests block publication. Untouched proposals are comments and do not block it. Withdrawn/inactive work and historical decisions do not block later drafts. Verify content validity and consistency between settled candidate work and the approved effective snapshot; a gate that merely counts statuses is insufficient.

In one transaction, derive membership, enforce company/contract work gates, check the exact latest-draft identity and expected edit/review/approved-content revisions, validate blockers and capacity, freeze effective content/title, allocate the next public number, seal the draft, create its successor, and advance the root pointers. Return both identities. First-link capture also allocates its stable link atomically: a failed approval gate, capacity check or token allocation leaves no partially created V1/link. Copying an existing link never publishes or flushes unrelated work.

Use actor-scoped operation receipts containing contract, draft, expected state and operation identity. An exact committed retry returns its original publication even after a later publication. Concurrent different publish operations cannot seal one draft twice or allocate duplicate numbers; the loser receives a stale-context conflict. Save/approval/withdrawal races either commit before the checked snapshot or fail against the sealed/stale draft. Discussion writes read the same version lifecycle so sealing/supersession serializes with them. Retain exact confirmation of writes already committed, without admitting new stale work.

Remove implicit buyer release from saves, approvals, creation/rename and HubSpot reassociation/rename. Retain internal approval advancement where needed. Retire `publicationAcknowledgments`, the old `PUBLICATION_CONFIRMATION_REQUIRED` API/retry branches, and `PublicationWarning`/modal copy that says approval immediately changes buyer wording. Explicit publishing owns its own progress, errors and exact retry state. Keep one publication system in the final model.

## 5. Bind discussions and accepted proposals to source and target versions

Add version ownership to threads, messages, receipts and request origins. Update all feed, thread/message, reply/edit/delete and receipt entry points in `discussions.ts`, `discussionService.ts`, public HTTP ingress and frontend discussion access/session types. A thread or message ID cannot bypass the authorized selected version. Validate new anchors against that context's actual projection/revision and preserve exact provenance in history.

The latest internal draft permits private discussion. The buyer-current publication permits buyer-visible discussion even when an internal draft is ahead. Sellers must switch to that published version to participate in that conversation. Superseded publications reject new threads, replies, edits, deletes and acceptance on the server and in controls. Private `markSeen` may acknowledge historical messages actually visible to an authorized viewer; clearing unread bookkeeping does not grant content-write permission. Preserve author ownership, buyer identity and quotas.

For acceptance from the buyer-current publication, record and atomically validate both the frozen source version/thread/message revision and the exact target latest draft. Compare the affected source wording/dependencies with both the target's approved effective content and its candidate work. The approved seller preview must not conceal an overlapping pending dashboard replacement. Unrelated internal work may coexist; overlapping changed wording or dependencies return an explicit conflict without a partial request. Reuse `normalizeProposal`, range normalization and source/dependency machinery with these explicit contexts instead of two views that dynamically resolve current approvals.

The originating discussion remains on its source publication. The accepted request and decisions belong to the target draft. Approval rechecks recorded source revision and target dependencies, advances only approved internal wording, and still needs publication to reach buyers. Freeze source/target identities throughout review and retries; never substitute a successor draft. Source edits/deletes can invalidate or withdraw live nonapproved requests under the existing rules, but cannot mutate previously approved effective wording, frozen publications or historical decisions.

## 6. Bind browser editing, recovery and navigation to the version

Update `src/lib/contract/editors.svelte.ts`, `persistence.svelte.ts`, draft values/storage/recovery, snapshot metadata/cache, route-opening acquisition and retained document resources. Mutable ownership, journals, saved requests and live subscriptions use contract plus version; rendering/preparation additionally uses projection and complete content identity. Retain account, membership and deployment isolation. Historical reads never acquire an autosave owner.

Before publishing, flush the publishing browser's applicable draft saves and wait for acknowledgment, then send the exact resulting draft/revisions. Another browser's unsaved work cannot be included. When a teammate publishes, seal the old editor, stop new writes and safely retire its subscriptions. A view following latest adopts the successor. Keep unresolved local intent attached to its original version with an explicit conflict/recovery path; never silently replay or rebase it into the successor. Exact committed requests reconcile through their original receipts; uncommitted work must not be reported as saved.

Version/projection changes rekey discussion composers, selection/highlight/search state, displayed identity, pending downloads and callback generations while retaining legitimate local intent per context. Preserve bounded opening/recovery concurrency, atomic complete-input readiness, saved-creation handoff, Home's idle preparation, confirmed-only caching and shared immutable template reuse. An approved projection must not reuse candidate prepared content merely because version IDs match. Access loss/sign-out removes private inputs from visible buyer surfaces and ends their read/write ownership.

## 7. Add seller publication and version navigation

Update `BuyerShell.svelte`, `seller.svelte.ts`, `contract.svelte.ts`, `BuyerDocument.svelte`, `BuyerContractPage.svelte`, saved-contract/rep workspace and document tools. The seller link currently adds private controls to anonymously loaded released content. After authenticated teammate recognition it must default to the latest draft's approved inputs. Pending/declined candidate wording remains visible in the dashboard for review. `View as buyer` selects the actual latest publication and retains its existing preview interaction restriction; returning restores the seller context.

Add `Publish to buyer` at the bottom of the authenticated seller-side buyer link, using the common eligibility/flush controller. Identify the target draft, active blockers and progress, and allow any current team rep/admin. A historical selection must not silently publish a different version: direct the seller to the latest draft and its control. Keep first-link entry points on Home cards and existing contract link controls, using the same initial publication transaction and stable URL.

Extend `UtilityRail`/`DocumentTools` with version navigation and the mobile counterpart. Sellers see the latest draft and published history; buyers see published history only. Show the tool when that audience has more than one selectable context, including draft plus V1 for sellers immediately after first link creation. Use route/query selection so reload, back and forward preserve explicitly selected history. Omitted selection follows latest for that audience. Clearly distinguish the current draft, buyer-current publication and superseded history; derive control permissions from server capabilities.

Keep static styling inline in Tailwind. Preserve `BuyerLinkController.onCopied → BuyerLinkCopyFeedback.show → WorkspaceShell.CopyConfirmation`: one shared `StatusBubble`, “Latest link copied,” centered in the workspace status area, raised 8px and dismissed 2.5 seconds after the latest successful copy. Keep it above Past links. Contract-bar link errors replace its explanatory sentence in red for five seconds; card errors use the shared bubble in red for five seconds. Clipboard failures have no manual-copy fallback. Versioning must preserve this path for Home, contract-bar options/create-link and Past links.

## 8. Export only the latest publication from every surface

Replace `documentExport.approvedExport` with a shared latest-publication boundary. Update `savedContractValidators.exportRequest`, `contractExports.ts`, `wordExport.ts`/`exportActions.ts`, `hubspotQuotes.ts`/`hubspotQuoteActions.ts`, export/quote validators and frontend Word/quote controls. Include buyer `download.svelte.ts`, `/api/buyer/[token]/download`, content acquisition and final `authorizeDownload`.

All exports target an explicit latest published version and its frozen title/content. Draft and historical surfaces may offer export of the latest publication with that target clearly identified; they never export their displayed unpublished/older text. Decouple readiness from live draft saves, conflicts, required-review status, selected-definition loading, title and edit/review counters. Pending or declined draft work cannot block or invalidate an otherwise permitted published export. Preserve current membership/company/link/integration/destination permissions, provider constraints and retention rules.

Attempts, payload validation and provenance reference the immutable publication instead of recomposing active effects or retaining an independent source of document truth. Before releasing new bytes or dispatching a new provider operation, freshly authorize the captured publication against the latest-published pointer. A new publication makes an undispatched attempt stale and requires a new request; draft-only changes do not. Generation, reservation and retries never silently retarget to newer content. Preserve the final public-download authorization after Word generation.

Keep semantic quote deduplication separate from publication identity: a same-wording publication may reuse a remote quote only after reauthorization for the requested latest publication and current destination. Preserve truthful acknowledgment of downloads already initiated and reconciliation of provider side effects already dispatched, including uncertain outcomes. A later publication must not erase success evidence or cause duplicate remote operations. Already released bytes/storage URLs cannot be revoked retroactively.

## 9. Scope side effects and remove obsolete paths

Carry version identity through review requests/completion generations, email delivery captures/deep links, operation receipts, notification destinations, HubSpot negotiation events and export records. Scheduled work acts on its recorded version or becomes explicitly stale; sharing a stable contract ID cannot retarget it to the successor. Preserve delivery retries, retention, provider uncertainty and acknowledgment guarantees. Buyer identity/activity and unread summary may remain contract-aggregated; captured document inputs, anchors and events retain their actual version.

Update `contractCleanup.ts`, company deletion, storage ownership and existing seed/fixture paths for version/content children. Cleanup stays bounded and restartable. Update `docs/data-model.md`, lifecycle and HubSpot/export documentation. Search for obsolete `contractBuyerState` buyer release, automatic-publication warnings, unscoped review/discussion access and public/history/export composition through current active approvals. Remove abandoned tables/APIs/UI branches after callers and data are moved; keep only the useful internal approval-advancement behavior.

## 10. Prepare a proportional existing-data cutover

The current app has one mutable buyer projection and contract-scoped discussion. It cannot reconstruct lost publication chronology. Prepare a bounded, resumable, nondestructive conversion with temporary schema compatibility only for rollout. Inventory real records before choosing mappings for ambiguous legacy review history; do not invent prior numbered versions or a permanent second data model.

For linked contracts, atomically materialize the exact currently buyer-visible effective projection as imported V1, including custom definitions and anchor identities. Create the current draft from actual candidate/review state and its actual last-approved effective projection, preserving active blockers. Do not put newer pending internal text into V1 or discard earlier approved content hidden by candidate replacements. For unlinked contracts, create the initial draft and preserve its candidate/approved state; create no buyer-visible V1 before link creation.

Existing publicly readable discussions remain with imported V1. Preserve identifiable current requests and decisions with their defensible owning context. Mark ambiguous imported history honestly using migration provenance on the retained records; do not fabricate per-publication chronology. Stable links remain intact. Old exports/deliveries can retain a publication reference only where their captured provenance proves it. Otherwise expire undispatched intent explicitly while retaining the evidence needed to reconcile already-dispatched side effects.

Convert and reconcile each contract transactionally, or use a brief write hold where conversion cannot fit, so reads/writes never see partially converted state. Versionless browser recovery data stays recoverable or maps only when its exact original draft is provable; never discard it silently or attach it to a successor. Remove compatibility fields/tables after conversion and pending-operation handling are verified. Preparing code for this conversion does not authorize a database reset, migration execution or deployment; those actions require an explicitly authorized target and rollout.

## Validation and evidence limits

During implementation, maintain affected existing fixtures and assertions without adding tests, expanding the suite or weakening guarantees. Existing checks cover useful foundations, rather than the newly introduced version behavior:

- Saving/performance assertions cover unchanged-save cost, changed-save work, invalid selections, exact replay/stale-save ordering, immutable snapshot reuse and first-link stale-flush refusal. Preserve these guarantees under the new identities; do not retain assertions about the obsolete table layout merely for its own sake.
- Existing lifecycle checks cover editor/recovery/read ownership, stale transport isolation, complete document inputs, creation handoff and loading/copy flows.
- Existing HubSpot/export checks cover reserved snapshot preparation, download acknowledgment/idempotency, attachment lifetime, reconciliation and delivery safety. Adapt the reserved-snapshot fixture to create a publication and then change only its internal draft, preserving the frozen-content guarantee. Keep meaningful provenance/chunking assertions where storage still uses that format.

Run `npm run test:perf` because saving, scheduling and caching change. The breadth of this change warrants one final `npm run verify`, whose actual sequence is lifecycle (including SSR), perf, HubSpot, build (including Svelte/tools checks), then loading-bundle verification. Use focused existing checks during implementation and avoid needlessly repeating successful suites. Separately run `npx tsc --project src/convex/tsconfig.json --noEmit`; `verify` does not replace the backend type check. Perform targeted formatting/whitespace checks. Any code generation that affects a running deployment remains subject to the deployment authorization boundary.

Source-review the following acceptance scenarios and give the user a compact sequence for their browser/multi-user checks:

1. Pre-link approved wording appears in V1; approval later changes seller-approved text while buyer text stays frozen. A → approved B → pending/declined C shows A to buyer, B to seller and C in dashboard; withdrawing C restores B without reapproval. Deliberate removal/reversion remains distinct.
2. Every active blocker prevents publication, including accepted buyer proposals; withdrawal unblocks it and retains history. Untouched proposals do not block. Successors inherit approved wording without new review submissions.
3. Buyer-current V1 discussion stays open while Draft V2 differs; seller must select V1 for buyer-visible replies. Accepting an unrelated V1 proposal targets the latest draft; overlapping approved or pending candidate work conflicts. Approval alone never changes buyers. Superseded V1 rejects all content writes.
4. Old text, replacement identities, anchors, comments and decisions remain with their owning version. Draft/candidate/private content cannot leak through tokens, previews, IDs or caches. Projection switches cannot reuse incompatible prepared content or validate actions against the wrong wording.
5. Pending internal work does not block latest-publication Word/HubSpot exports. Superseded undispatched attempts fail freshness checks; already initiated downloads/dispatched provider results still reconcile truthfully.
6. Concurrent publish/save/approval/discussion operations and exact retries preserve one publication and the correct owning version. Unsaved/recovered old intent never enters a successor automatically.
7. History reload/back/forward and mobile navigation select the correct context. `View as buyer` shows the actual publication. Link copy confirmation and error presentation remain intact.

The user checks the browser; no Playwright/browser automation is planned. Existing tests do not establish these new runtime, authorization and multi-user scenarios. Report exact automated results separately from source-reviewed and still-unverified behavior; do not claim a type check proves publication correctness.

## Material assumptions and risks

The proposed implementation uses these assumptions for approval: sealing a draft opens its successor immediately; draft comments become visible on that version's publication while private review records remain private; first-link creation uses the same all-approved gate and exports are unavailable before V1; deliberate same-wording/comment-only publication still creates a numbered version, while exact retries do not. These are recommendations, not separately confirmed product answers.

The main risks are retaining last-approved internal wording and exact effect/anchor identity, keeping inherited approval provenance separate from new review history, preventing stale browser/scheduled work from crossing version boundaries, and changing export freshness without corrupting external-operation reconciliation. Legacy history has real attribution limits; resolve those from an authorized inventory while preserving evidence and the single final version model.
