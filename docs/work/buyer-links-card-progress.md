# Buyer links card

Scope: restore Contracts/Buyer links headings (subsequently tuned to 13.5px medium); add a historical-Home-style card on the right (450px at 1000px+), below Contracts on narrow screens. Hide the whole section when empty. All company admins/reps see all company links, newest first, ten initially and three per Show more. Names are 13px regular; each row opens the existing buyer URL in a new tab and has the existing recent-activity button. Integrations stays unchanged.

Decisions: use the existing buyerLinks company index and current savedContracts buyerCompanyName. No schema changes, migrations, compatibility layers, or database reset. Filter missing contract roots during asynchronous deletion and continue filling through empty pages. Preserve contract grid measurement and shared copy confirmation.

Evidence: historical card at git 9b6e581, src/lib/components/workspace/IntegrationCatalog.svelte; current bottom-bar anchors use buyerPath. requireMembership derives company server-side. WorkspaceBoundary keys scope by profile/membership/company.

Completed: plan-refine planner/evaluator/reviser; company-scoped native paginated query; BuyerLinks card; conditional layout and headings; independent pagination/retry.

Validation complete: npm run build passed, including Svelte diagnostics (zero errors/warnings), tools TypeScript checks, and production client/server builds. npx tsc --project src/convex/tsconfig.json --noEmit passed. Changed files formatted and diff whitespace check passed. Reviewed company isolation, native pagination metadata, orphan-page fill, scope remounts, and new-tab anchors.

Deployment follow-up (2026-11-11): local app targets dev:disciplined-squid-496. Read-only function metadata confirmed buyerLinks.browse was missing and no Convex watcher was running. Ran npx convex dev --once --typecheck enable --tail-logs disable successfully; read-only metadata then confirmed buyerLinks.browse is deployed. No database wipe performed; production untouched.

UI follow-up: moved LinkActivity from ContractCard to the right of each buyer-link row as a sibling of the anchor. browse now returns the authorized contractId to reuse the existing activity component unchanged. Removed its contract skeleton placeholder and reduced reserved contract-card space. Matched link-row padding to contract cards (9px vertical, 11px left, 56px right reserved for controls; control inset 11px) and matched the 20px name line height. npm run check passed with zero Svelte errors/warnings; Convex push with typecheck enabled succeeded on the same dev deployment. Final padding adjustment passed diff whitespace checking.

Unverified: visual layout and authenticated live query/retry/pagination behavior; no browser checks or tests performed. Saving/scheduling/caching were not changed by this feature, so test:perf was not required. Implementation complete.
