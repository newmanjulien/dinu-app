# Publication and version implementation

Historical work log. Its draft/successor and publication-based seller-export model is superseded by [the current data model](../data-model.md), [lifecycle](../lifecycle.md) and [retained rollout gates](../deployment.md#backend-ownership-conversion). This log is not a deployment or conversion certificate.

> Historical implementation/review snapshot. Recorded results describe that stage only.
> Contract conversion, tuple-chunk and compatibility instructions below are superseded by
> the [current contract release procedure](../deployment.md#backend-ownership-conversion).
> Read the current architecture in [data model](../data-model.md); no live cutover is certified here.

Scope: implement approved `contract-publication-versions-plan.md`; user approved with “go” and subsequent “continue”. Preserve the pre-existing dirty workspace. No deployment, live migration, provider call, browser check, new tests, or expanded test coverage authorized/performed. User requested one subagent at a time; subsequent review tasks ran sequentially.

## Decisions and implemented structure

- Dashboard candidate, private approved draft, immutable buyer publication. V1 is captured with first-link creation; each publication seals that version and creates the next shared internal draft. Exact operation replay returns its original result; unchanged intentional publication creates a new version.
- Active pending/declined concessions and accepted proposals block publishing; withdrawal restores approved baseline and keeps history. Untouched proposals are comments.
- Version-scoped saving, recovery, rename, reviews, discussions, source anchors, and seen receipts. Historical dashboard editors use separate identities and never write latest recovery/cache. Old uncertain save receipts reconcile without moving local intent to successor versions.
- Approved wording/effect dependencies survive review resets. Overlapping template selections that would be silently suppressed by approved buyer wording now fail explicitly before save.
- Seller buyer-link reads approved internal wording; View as buyer reads latest publication. Historical public reads reject drafts. Current buyer publication remains writable for discussion; older publications are read-only. Draft comments remain draft-only.
- Versions picker in shared desktop/mobile tools. Dashboard and buyer-link routes select by version. Publish to buyer is at the private draft footer; blocks pending/declined work and stale/unrendered content. Copy confirmation path preserved.
- Word and HubSpot exports capture latest publication independently of the selected version and draft activity. Existing delivery, acknowledgment, retention and reconciliation boundaries retained.
- Bounded fingerprinted migration tools prepared; never executed. Existing deployed contracts require conversion before rollout.

## Final verification

- `npm run test:perf`: 39/39 passed after final backend conflict guard (`/tmp/version-final-perf-2.log`). Covers unchanged-save cost, changed-save work limits, creation and immutable cache reuse.
- `npm run test:hubspot`: 60/60 passed (`/tmp/version-final-hubspot-3.log`). Existing first-publication fixture now uses buyer-link capture; export/delivery/security assertions retained.
- Targeted existing lifecycle checks (contracts, loading recovery, creation snappiness): 29/29 passed (`/tmp/version-final-lifecycle-3.log`). Subscription-order assertion requires version metadata before selected definitions. Exact request replay/account-exit guarantees retained.
- Backend TypeScript compilation passed (`/tmp/version-final-backend-tsc.log`).
- Final `npm run build` passed, including Svelte/type/tool checks with zero errors and warnings (`/tmp/version-final-build-3.log`). Includes the final version-conflict recovery UI.
- `npm run verify:loading-bundles` passed (`/tmp/version-final-bundles.log`): public account frame, Contracts and buyer entry keep document dependencies lazy.
- Scoped Prettier and `git diff --check` passed. No tests added or coverage expanded; existing fixtures/assertions maintained for the intended version semantics.

## Rollout and validation limits

Local implementation complete. No deployment or migration execution performed. Existing deployed data requires the prepared conversion before rollout; versionless browser recovery remains stored and blocks editing when its original version cannot be proven. Browser interactions, new multi-user/version authorization scenarios and native HubSpot provider dispatch were not exercised. User will check UI; new test coverage was not requested.

Evidence: approved plan, discovery, and backend/discussions/exports progress files alongside this document. Detailed check logs are in `/tmp` paths above.
