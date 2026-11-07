# Contract directory

Current architecture: [data model](data-model.md). Release mechanics: [production releases](deployment.md).

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
