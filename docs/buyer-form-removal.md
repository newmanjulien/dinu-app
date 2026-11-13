# Retired buyer form data

Historical form removal is complete in the current contract architecture. Permanent buyer
links open the contract's one current approved document through `buyerLinks.currentView`.
See the [current data model](data-model.md#buyer-links-and-shared-discussions). The
form/readiness APIs, `contractBuyerState` and the old
`buyerLinkMigration:removeFormData` procedure are absent.

The old incremental form cleanup is superseded by the coordinated incompatible contract
cutover in [deployment](deployment.md#backend-ownership-conversion). Do not invoke removed
functions or restore retired tables. No deployment, cleanup or data wipe is performed by
local documentation or build commands.
