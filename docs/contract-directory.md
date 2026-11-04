# Contract directory

Current architecture: [backend model](backend-redesign/architecture.md). Target/archive/reset/deploy and remaining native/browser/provider verification: [Phase 18](backend-redesign/phase-18-activation.md). Local implementation evidence does not establish deployment.


`contractDirectory` is the sole source for Home browsing and customer-name search.
It stores contract/company/creator IDs, displayed company name, save time and the
contract's original creation time. Selections, review state and immutable template
content remain outside the directory. There is no readiness flag, source-selection
argument, fallback reader or backfill worker.

Creation, changed saving, renaming and deletion maintain the projection in the same
transaction as the contract. Unchanged saves and replayed operations preserve their
zero-write behavior. A source-contract company index remains for deletion; browse
and search indexes belong only to the directory.

Both startup and live browsing use the same authorized reader. Blank browsing sorts
by descending save time and original creation time; nonblank search uses Convex's
company-filtered full-text index. Native pagination options and result split
metadata pass through unchanged. Names and avatars resolve from current company
membership, once per distinct creator per page; former colleagues retain the
existing label.

Contract deletion removes its directory row immediately and leaves a durable
company-scoped cleanup marker for decisions, deliveries and their snapshots.
Company deletion drains directory rows and cleanup markers with the shared bounded
worker budget.

[Phase 10](backend-redesign/phase-10-contracts.md) records the implementation and
acceptance limits. All 24 existing performance tests, backend TypeScript, Svelte
checks and production build passed locally. Creation still requires two
contract/receipt writes and one directory write without reading/compiling template
content. No tests were added or assertions weakened.

The October 25, 2026 development observation of one 299-JSON-byte directory record
is historical context only; it is not a current scale or latency measurement.
Deployed search/pagination, cleanup interruption/company overlap and actual
opening timing remain unverified. The earlier readiness/backfill rollout procedure
is retired. Source/schema changes have not been deployed; Phase 18 owns the agreed
target-specific fresh reset and bootstrap.
