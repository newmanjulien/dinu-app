# Contract directory

Home lists and searches compact `contractDirectory` records instead of reading full
`savedContracts` documents. Each record contains the contract, company, and creator
IDs, the displayed company name, save time, and original creation time. Selections,
review state, and template content remain outside the directory. Creator names and
avatars are resolved from current company membership when reading cards.

Creation, changed saving, renaming, and deletion maintain the directory in the same
transaction as the contract. Unchanged saves and replayed operations retain their
existing zero-write behavior. Company deletion drains directory entries after
contracts using its existing bounded cleanup budget.

New companies start ready. Existing companies browse the original source until a
bounded backfill completes. `contractDirectory:backfillAll` scans 25 companies per
batch and schedules `contractDirectory:backfill` in batches of eight contracts.
Backfill keeps its cursor and schedules a continuation after 60 seconds during
preparation or dispatch holds. Cancellation or expiry lets that continuation resume;
confirmed cleanup terminates it. The worker can restart safely, and concurrent
contract mutations maintain the same entries. Completion marks the company ready.

Home includes the readiness flag in its live browse arguments, so pagination starts
again when the source changes. Previously displayed cards remain while that first
page loads. Clients omitting the flag retain the original source, preserving their
existing pagination cursors during rollout. Both sources apply the same company
authorization and return the same card shape.

After identifying and announcing the intended development deployment, start backfill
with:

```sh
npx convex run contractDirectory:backfillAll '{}'
```

On October 25, 2026, the backend was deployed to development deployment
`scrupulous-squirrel-986` and both companies completed backfill. Its one directory
record was 299 JSON bytes and contained only the expected metadata fields. These
counts describe that development dataset, not production scale or latency.

The existing 24 performance and 20 lifecycle tests, Svelte/type checks, production
build, and Convex type check passed. Affected saving and creation assertions retain
their existing guarantees and separately count directory writes. No tests were
added. Browser search/pagination, concurrent backfill edits, company deletion, and
before/after load timing remain unverified for this change. Production is unchanged.
