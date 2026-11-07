# Integration catalog

`src/lib/integrations.ts` owns the informational catalog shared by all workspaces. Home and `/integrations/[slug]` read it synchronously from application code. Catalog content ships with the website; it requires no Convex queries, mutations, table or seed command. Optional company contract/playbook seeding is independent and unchanged.

Both views display content only while the workspace is admitted and the current membership is an admin. This is a presentation gate: the informational copy and logos are bundled application assets. Provider connections, credentials and synchronization state are outside this catalog.

## Content maintenance

Edit the ordered `integrations` array in `src/lib/integrations.ts`. Array membership controls visibility and array order controls display order. The current order is HubSpot, HubSpot Quotes, Gong, Salesforce, HubSpot Contracts. Keep stable lowercase URL-safe slugs and unique section keys.

Each entry contains its slug, name, logo path, summary and content. `content.kind: 'details'` enables Learn more and supplies a tagline, ordered plain-paragraph sections, developer, category and labeled external links. `content.kind: 'comingSoon'` disables the card action. Only HubSpot currently has details. `findIntegrationDetails` returns no entry for unknown or Coming soon slugs, so direct navigation to those slugs shows the existing unavailable message.

Logos live under `static/integrations/`; use a corresponding `/integrations/` path and verify the file exists. The Salesforce logo comes from [Salesforce’s official logo asset](https://www.salesforce.com/content/dam/sfdc-docs/www/logos/logo-salesforce.svg). External links should use absolute HTTPS URLs without credentials. Changes to copy, links, logos or availability take effect with the next website publication.

## UI

`HomeSections` is a pure layout. `IntegrationCatalog` initially displays three entries. Show more reveals the next three locally, then disappears once all entries are visible. With the current catalog, Salesforce and HubSpot Contracts appear after one click. There are no catalog network loading, error or retry states. `IntegrationCatalogSkeleton` remains part of the broader asynchronous Home startup skeleton.

The generic detail route keys its component by slug. Both views react to admission/admin changes, and detail lookup reacts to the current slug. Breadcrumb and Back to home navigation remain available for unavailable entries and non-admin users.

## Transition and release

Before the first static-catalog website publication on each target, read its existing stored catalog and compare all editorial content, visibility and order with the shared code snapshot. The previous seed inserted missing entries without replacing existing edits, so the former seed fixture alone cannot establish parity. Reconcile differences into the intended shared catalog before publication.

Ordinary releases deploy Convex before publishing the website, and older served pages or open tabs may still call the previous catalog APIs. Establish whether any supported clients need those APIs before deploying their removal. If consumers remain or their status is uncertain, first publish the static frontend through a temporary release retaining the old catalog backend and schema, then remove that backend after those clients retire. See [production releases](deployment.md) for the release sequence.

Removing the schema declaration does not delete legacy stored catalog records. Physical cleanup is optional, separately scoped housekeeping; it is unnecessary for the application catalog to be independent of Convex. No deployment or remote cleanup is implied by the source change.

## Validation

Use scoped formatting checks, `npx convex codegen --typecheck enable` for generated backend types without deployment, and `npm run build` for Svelte/type checks and the production build. Review content, unique slugs/section keys, links and logo files. Browser layout, focus, Show more, direct routes and live access transitions require manual review. The HubSpot entry has the live connection behavior described in [the HubSpot runbook](hubspot.md); other catalog entries remain informational.

## HubSpot connection

The HubSpot header uses Install, Installed and Reconnect instead of Website and HubSpot Support. An admin connects one HubSpot account for the workspace. Installed workspaces require a deal for new contracts; creation, first association of existing contracts and unavailable-link repair share a searchable picker showing at most three deals. A confirmed deleted/inaccessible deal blocks new edits, reviews and downloads until replacement. Temporary outages pause provider access without clearing the association or making manual creation available. Viewing, deletion, repair, accepted retries and already initiated download acknowledgments retain their authorization rules. Current company editors can repair unavailable links inside the open contract; cards do not show deal-link callouts. First association and relinking rename the contract to match the selected deal’s verified name and send future activity to that deal. Content and approvals remain intact. Contract metadata is projected into the existing directory; browsing does not hydrate snapshots or call HubSpot per card.

See [HubSpot setup, delivery and recovery](hubspot.md) for OAuth configuration, activity scope, retention, validation and rollback.

HubSpot activity uses the durable local outbox with direct Workpool execution. Unavailable link generations stay paused; original uncertain writes can reconcile without moving history to a replacement. Export retry lasts one hour from reservation, separately from the upload hold; complete ordered selection/review provenance is retained. The runbook describes physical cleanup grace and the development-specific executor cutover.
