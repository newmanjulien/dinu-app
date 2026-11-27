# Current activity model

The strict application retains `buyerActivityOpenings`, receipt-backed distinct-clause witnesses, `buyerActivityCounters`, required server `acceptedAt`, verified profile/city attribution, and fixed expiries. It removes raw link-open/visit/browser/stat tables, historical clause membership, copied-link membership facts, old cleanup phases, former buyer quota names, and the projection callback.

Activity intake commits opening/receipt/count changes atomically. Current limits remain `activityBrowser`, `activityLink`, `activityCompany`, `discussionActor`, and `discussionCompany`. Owner writes are throttled; daily owner expiry waits a half-refill grace to preserve the full refill guarantee. Seller activity is a bounded live query, with display-clock expiry filtering and daily physical cleanup.

The essential `dinu_discussion_browser` cookie still adopts an existing valid `dinu_buyer_browser` value on interaction, preserving anonymous comment ownership. Activity cookies contain scoped recognition identity only. See [current policy](cookies-and-activity.md) and [data model](data-model.md#buyer-link-activity).

The current release requires a fresh database and matching backend/frontend. The old preservation conversion/gate workflow is retired; dated commands must not run against current source. See [deployment](deployment.md). No live inventory, deletion, reset, or deployment was performed by the implementation.
