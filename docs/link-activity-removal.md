# Legacy activity retirement

The current activity feature records openings and receipts directly. Receipts also
witness distinct clause membership. It never reads legacy buyerLinkOpens,
buyerVisits, buyerLinkStats or buyerLinkBrowsers. Old writers are stopped; the old
buyerVisits.project scheduled entry point is retained as a harmless no-op so queued
legacy jobs cannot recreate data. See [current policy](cookies-and-activity.md).

Do not run old numbering or visit-projection backfills. Do not carry global browser/account identities into the current model. Schema admission and
contract/company deletion retain legacy compatibility until all supported deployments
have completed retirement. Account deletion removes legacy profile-linked activity.

Before changing deployed data, explicitly select and inspect the deployment read-only:
writer release, table counts/oldest rows, company/contract ownership, scheduled jobs
and in-progress deletion markers. Empty deployments need no backfill. Preserve
anonymous discussion ownership: the new essential cookie adopts the old browser
cookie value on interaction. Do not remove that compatibility merely because legacy
analytics has been purged.

For a populated deployment, after the legacy writer is confirmed stopped, the
internal operator mutation `buyerActivity:retireLegacy` accepts
`{ "companyId": "...", "writerStoppedAt": 0 }` (use the actual confirmed timestamp).
Each call is bounded; repeat the same arguments until `done: true`, then repeat to
confirm `removed: 0`. It drains only the four legacy activity tables for that company.
It does not delete comments, accounts, contract links or current activity.
Production deployment and retirement are separate, explicitly authorized operations.
No retirement or live data inventory has been performed by the local implementation.

After every supported deployment is verified empty, remove retired table definitions,
optional analytics fields, old deletion drains, migration entry points and no-op
projector. Preserve admission for any in-progress cleanup phases until completed.
Do not clear the shared rate-limiter component globally; owned limits expire/reset
through their existing bounded cleanup and parent-deletion paths.

## Selective account erasure

Current same-company attribution uses `buyerActivityOpenings.by_profileId`. Account
cleanup drains these openings and their receipts/historical clause memberships using
`by_openingId_and_itemId` before erasing the profile. This bounded pass runs independently
of legacy progress, including when `legacyActivityPhase` is already `done`.

Before enabling the indexed account eraser, confirm `buyerLinkOpens.by_profileId`,
`buyerLinkOpens.by_visitorKey` and `buyerVisits.by_profileId` are ready in the selected
deployment. Large inventories may require staged index backfill before reader cutover.
The existing `opens` phase drains profile matches and then `account:<profileId>`
visitor-key matches across all companies, restarting each bounded range from its
beginning. `visits` drains profile matches; `done` preserves completed progress.
Old global `legacyActivityCursor` values are ignored and cleared as their current
phase resumes. Keep optional cursor admission until every supported marker advances.

## Receipt-backed clause counts

Prepare the receipt `by_openingId_and_itemId` index and optional historical
`acceptedAt` admission before the new writer cutover. Confirm index readiness and
that all unexpired membership rows have matching receipts, with all supported writers
obeying the prior atomic receipt/membership co-creation rule. The new writer uses
receipt existence for distinct counts and stops membership/timestamp writes.

Keep `buyerActivityClauses`, its validator and expiry/contract/company drains until
historical rows are verified empty. Keep receipt `acceptedAt` optional until older
receipts containing it are gone. If unexpected active membership-only rows exist,
postpone cutover until their fixed deadlines and verified cleanup; do not invent
receipts, reset counts or delete active replay witnesses. The fixed 30-day lifetime
allows these compatibility surfaces to retire after cleanup is proved. No live
inventory, index backfill, writer cutover or table removal has been performed locally.
