# Contract and buyer-link search

The workspace search bar sends the same debounced company/contract name to the
contracts and buyer-links queries. Both search `contractDirectory.title` through
`search_title`, filtered by the authenticated membership's `companyId`. Buyer-link
search filters `hasBuyerLink: true` after the directory backfill, then checks
each link's live published pointer and company before returning its token. Before
the backfill completes, search checks all matching directory rows for a live link.
Each column has its own cursor.
Blank contract browsing uses `by_companyId_and_savedAt_and_createdAt` descending;
blank link browsing puts unread comments first, then orders by link creation time.
Until the backfill completes, blank link browsing uses the existing newest-first
buyer-link index so older links remain visible.

`contractDirectory.hasBuyerLink` is derived from the existence of a same-company
buyer link with `currentView`. First-link creation sets it in the same transaction.
Contract saves and renames preserve it. Logical deletion revokes the pointer and
removes the whole directory entry atomically, including retries with an owned
cleanup marker. Publishing a link does not change contract order.

Only unfiltered first pages are saved as default-list snapshots. Search results
cannot overwrite those snapshots or company-wide link-presence hints. Changing the
term resets link pagination and visible rows. Empty results are definitive only
when the current query has exhausted all pages, including empty intermediate pages.

## Rollout

Deploy the backend schema/functions before releasing the updated frontend. The new
flag is optional solely to permit existing directory records during the backfill.
Wait for `search_title` and the new priority index to be ready. On a large existing
directory, first deploy only the new priority index as staged while the old browse
function remains in place. After Convex finishes building it, deploy these
functions with the index unstaged, then run the backfill. The priority query
cannot use a staged index.

Run the internal `contractDirectory:backfillBuyerLinks` mutation with
`{"paginationOpts":{"numItems":100,"cursor":null}}`. Pass the returned
`continueCursor` as the next `cursor` until `isDone` is true. The mutation accepts
ordinary continuation pages, rejects page targets above 100 and explicit non-null
`endCursor` ranges, is idempotent, and reads current link availability in the same
transaction as each directory update. Its final page writes a completion marker;
the browse query then uses the priority index and search filter. In-progress
backfills retain the previous newest-first browse order.
Once the backfill is complete, the optional schema field can become required in a
subsequent backend deployment.

These deployment/backfill steps are operational work; local builds do not run them.

## Manual verification

- Search a common name, final-word prefix, multiple words, and case/punctuation
  variations. Both columns should match by the same title.
- Find a link whose contract is outside the loaded contract cards; paginate both
  columns independently without duplicates.
- Type rapidly, clear the input, and search again. Older link results must not
  appear as matches for a new term; clearing restores ordinary browsing.
- Search for a name with a contract but no published link. Show the contract and
  the buyer-link empty message. Unfiltered browsing must still show other links.
- Rename a contract, create its first link, and delete it; verify reactive results.
- Verify another company's contracts and buyer links never appear.
- During the backfill, verify an older link still appears. After its final page,
  verify unread links move above read links, including across pagination pages.

`npm run test:perf` checks the existing saving, scheduling, caching, and startup
work guarantees. Type checks and the production build check integration. These do
not certify live search matching, index readiness, backfill completion, or browser
interaction; those require a configured deployment and manual verification.
