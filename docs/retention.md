# Contract retention and cleanup

`wordExports`, `hubspotExportDeliveries`, `hubspotQuotePushes`, and `operationReceipts` each own bounded operational lifetimes without secondary proof-chunk or compaction layers. See the [data model](data-model.md#email-caches-and-maintenance) for schema ownership.

## Separate clocks and holds

| Owner or obligation                        | End condition                                                                                   |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `operationReceipts`                        | 24 hours from creation; pruned daily via `operationReceipts.pruneExpired` (`by_expiresAt`). Preserved across single-contract deletion; wiped on company erasure. |
| Local Word download (`wordExports`)        | 1 hour from commit plus 15-minute physical read grace (`EXPORT_TTL_MS + EXPORT_READ_GRACE_MS`) |
| HubSpot Word attachment hold (`hubspotExportDeliveries`) | Up to 30 days from commit (`EXPORT_ATTACHMENT_RETENTION_MS`); positive File upload confirmation ends it early |
| HubSpot Quote private HTML (`hubspotQuotePushes.fileId`) | 30 days from commit (`hubspotQuotes.expire` payload pass); canonical dedup fences and provider facts survive for company lifetime |
| HubSpot Quote `providerFailure` diagnostics | 30 days from capture (`hubspotQuotes.expire` diagnostic pass), retained while push remains unresolved (`unknown`/`dispatched`/`verifying`/`attention`) |
| Buyer activity openings & receipts         | 30 days from acceptance (`buyerActivity.expire`)                                                |
| Pending template DOCX uploads              | 90 days from upload (`templateSetup.expirePending`)                                             |
| Frozen `templateVersions` & source chunks  | Company lifetime (never unfrozen when contracts are deleted)                                    |

## Word export expiry

`contractExports.expire` runs on a 5-minute cron, paging `wordExports` by `by_expiresAt` (20 rows / 1 MiB per pass). Once a row's local download window and any active HubSpot attachment hold plus 15-minute read grace elapse, expiry clears `fileId` and removes the unowned blob from `_storage` atomically (`deleteUnownedFile`). Confirmed HubSpot File uploads call `confirmUpload`, clearing `attachmentUntil` so the blob retires after the local download window and read grace.

## HubSpot Quote payload and diagnostic expiry

`hubspotQuotes.expire` runs on a 15-minute cron: its payload pass removes private HTML storage files after 30 days (skipping rows with an active worker lease) while preserving `canonicalKey`, `fingerprint`, `quoteId`, `url`, `state`, and operator recovery evidence for company lifetime, and schedules its diagnostic pass to clear bounded `providerFailure` diagnostics after 30 days once a push has reached a conclusive state (`verified`, `rejected`, or `retired`).

## Contract and company deletion

Logical contract deletion (`contracts.remove`) immediately revokes `buyerLinks.currentView` (`null`), removes the `contractDirectory` row, deletes `contractHubspotAssociations` and `contractBuyerRefreshes`, deletes `savedContracts`, and schedules `contractCleanup.clean`.

`contractCleanup.clean` drains child records in bounded phases (`deliveries`, `buyerLinks`, `buyerLinkShowings`, `buyerActivity`, `buyerQuotas`, `discussions`, `exports`, `hubspotQuotes`):
- Preserves `wordExports` rows whose HubSpot attachment upload is still pending/working/uncertain/blocked (their bytes expire under `contractExports.expire`).
- Cancels queued `hubspotQuotePushes` after any running lease ends; retains already-dispatched/conclusive Quote rows and `hubspotEvents` so canonical provider history survives.
- Preserves `operationReceipts` across single-contract deletion so creation, HubSpot deal, and Quote replay fences remain intact until their 24-hour TTL.

Company deletion (`companyDeletion`) drains every tenant table, pending cleanup marker, receipt, export, quote push, and stored file across bounded shared-budget phases without deleting external records previously written in HubSpot or Cal.
