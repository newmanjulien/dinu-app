# Dinu Contracts HubSpot app

This project registers the OAuth app used by Dinu's Install button. It has no HubSpot UI extensions, App Events or Custom Events.

Development app registered on 2026-11-06:

- Account: `test` (`343876639`)
- Project: `dinu-contracts` (`303455182`)
- App: `Dinu Contracts` (`60647715`)
- Client ID: `b8ec13ec-8baa-4575-87f9-4d9d9b4c7383` (public identifier)
- [Project and Auth tab](https://app.hubspot.com/developer-projects/343876639/project/dinu-contracts)
- Redirect: `http://localhost:5173/api/hubspot/callback`

The app uses account-level OAuth and private distribution. Add intended test/customer accounts to its allowlist in HubSpot. Marketplace distribution is a separate publication step. Register each deployed website's exact HTTPS callback in `src/app/app-hsmeta.json` before configuring that deployment's `HUBSPOT_REDIRECT_URI`. Keep local development and production credentials/configuration separate.

From this directory, validate with `hs project validate --account test --config ../hubspot.config.yml`. Upload changes with `hs project upload --account test --config ../hubspot.config.yml`. This account auto-deploys successful builds. The root CLI configuration contains credentials and must never be committed or printed.

`requiredScopes` includes Deals read/write, Companies read and Files read/write. Companies read enables the contract footer's customer name; existing installations need admin reauthorization to grant it. Register this scope in HubSpot before adding it to the backend's `HUBSPOT_SCOPES`. Deals write supplies Notes access; the integration does not modify deal properties. HubSpot rejected the old `files` scope on platform 2026.09, so granular Files scopes are used. A customer-style OAuth token must still prove endpoint permissions, attachment privacy and intended viewer access. Do not invent `crm.objects.notes.write`.

The client secret is configured on the development Convex backend. Future secrets must be set only on their matching backend, through the dashboard or CLI stdin. Continue with [the runtime runbook](../docs/hubspot.md).

## Quotes permissions

The manifest declares `crm.objects.quotes.read` and `crm.objects.quotes.write` in `conditionallyRequiredScopes`. The HubSpot Quotes install URL includes both in `scope`, making consent to both mandatory for that installation. It does not use `optional_scope`. The callback also rejects a token missing either permission before committing credentials or enabling Quotes. Upload this manifest before deploying the matching install URL; validating locally does not update the registered app. See [the Quotes runbook](../docs/hubspot.md#native-hubspot-quotes-add-on).

Build #3, uploaded and automatically deployed on 2026-11-07 to account `343876639`, registers both optional quote scopes. The development backend has both Quotes flags enabled. App OAuth consent and native editor review remain manual validation steps.

Build #4, uploaded and automatically deployed on 2026-11-07 to the same development account, additionally registers `crm.objects.companies.read`. The development backend's `HUBSPOT_SCOPES` includes it. Existing installations must reconnect to consent; live company lookup and retention of existing Quotes grants still require manual verification.

Build #5, uploaded and automatically deployed on 2026-11-07 to the same development account, moves both Quotes permissions from optional to conditionally required. The matching Quotes OAuth flow requests both as mandatory permissions. Start a fresh Quotes installation to verify the updated HubSpot consent screen; existing authorization tabs retain the previous URL.
