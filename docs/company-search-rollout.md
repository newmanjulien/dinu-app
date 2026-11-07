# Company search

Saved-contract search reads `contractDirectory` using Convex's `search_companyName`
index filtered by `companyId`. Blank browsing uses
`by_companyId_and_savedAt_and_createdAt` in descending order.
Authorization checks the caller's current membership before either query. There
is no prefix table, prefix writer, cleanup function, or global browsing index.

The schema declares the directory search index directly.

## Manual verification

- Search a common name, a final-word prefix, multiple words, and a name with case
  or punctuation differences; paginate without duplicates.
- Browse with a blank query; a changed save moves the contract to the front,
  while an unchanged save leaves `savedAt` intact.
- Rename and delete a saved contract; verify reactive results update.
- An empty page with more pages available still permits continuation. Only an
  exhausted empty result displays the definitive empty state.
- Verify another company's contracts never appear in either query.

Search matching and relevance ordering are Convex's built-in behavior. The installed
SDK version is 1.46.0. Documented limits include 16 query terms, 32 characters per
indexed term, and 1024 scanned search results; search primarily supports Latin-script
names. The frontend pagination target is capped at 48; reactive cursor ranges may
return more than that target. Optional pagination arguments and result metadata
are preserved.

These checks require a configured deployment; the local performance suite does
not certify search matching or live index readiness.

Reference: [Convex full-text search](https://docs.convex.dev/search/text-search).
