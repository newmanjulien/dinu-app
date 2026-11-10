# Retired buyer form data

Buyer links now open the contract directly. The form, readiness workflow and public
form APIs are removed. New captures only write the latest-link pointer to
`contractBuyerState`; seller history no longer returns answers or readiness.
Contract snapshots, download eligibility and opening activity are unchanged.

The schema temporarily accepts optional legacy `buyerLinks.readiness` and
`contractBuyerState.details`, `revision`, and `readyRevision` fields so existing
records do not block deployment. No application path reads or writes them.

After deploying the form removal to the intended environment, run the internal
`buyerLinkMigration:removeFormData` mutation separately for each table:

```json
{ "table": "buyerLinks", "cursor": null }
```

```json
{ "table": "contractBuyerState", "cursor": null }
```

Pass the returned `cursor` into the next invocation for the same table until
`done` is true. Each call reads at most 20 rows with a 200 KB page budget and
removes only retired fields. The mutation is safe to repeat and does not return
answers, tokens, or browser identifiers. Repeat each complete sweep from `null`;
every page should report `removed: 0`.

This permanently deletes stored form answers and submitted readiness. Choose and
confirm the deployment before running it; production cleanup is a separate release
action. The implementation does not run this operation automatically.

After both tables are clean on every supported deployment, remove their optional
legacy fields and validators from `buyerValidators.ts`, then retire the cleanup
mutation. Keep the `contractBuyerState` table and its latest-link pointer: link
resolution, replaced-version handling, history and deletion depend on it.
