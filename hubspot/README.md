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

`requiredScopes` includes Deals read/write and Files read/write. Deals write supplies Notes access; the integration does not modify deal properties. HubSpot rejected the old `files` scope on platform 2026.09, so granular Files scopes are used. The uploaded app accepted these scopes; a customer-style OAuth token must still prove endpoint permissions, attachment privacy and intended viewer access. Do not invent `crm.objects.notes.write`.

The client secret is configured on the development Convex backend. Future secrets must be set only on their matching backend, through the dashboard or CLI stdin. Continue with [the runtime runbook](../docs/hubspot.md).
