# Integration catalog

`src/lib/integrations.ts` owns the informational catalog shared by all workspaces. `/integrations` and `/integrations/[slug]` read it synchronously from application code. Catalog content ships with the website; it requires no Convex queries, mutations, table or seed command. Optional company template/instructions seeding is independent and unchanged.

Both views display content only while the workspace is admitted and the current membership is an admin. This is a presentation gate: the informational copy and logos are bundled application assets. Provider connections, credentials and synchronization state are outside this catalog.

## Content maintenance

Edit the ordered `integrations` array in `src/lib/integrations.ts`. Array membership controls visibility and array order controls display order. The current order is HubSpot, HubSpot Quotes, Gong, Salesforce, HubSpot Contracts. Keep stable lowercase URL-safe slugs and unique section keys.

Each entry contains its slug, name, logo path, summary and content. `content.kind: 'details'` enables Learn more and supplies a tagline, screenshots and ordered plain-paragraph sections. The former Details sidebar fields (developer, category, website, documentation, terms, privacy and support) are absent from the catalog model and entries; the catalog has no current Convex schema or API. `content.kind: 'comingSoon'` disables the card action. HubSpot and HubSpot Quotes have details. `findIntegrationDetails` returns no entry for unknown or Coming soon slugs, so direct navigation to those slugs shows the existing unavailable message.

Logos live under `static/integrations/`; use a corresponding `/integrations/` path and verify the file exists. The Salesforce logo comes from [Salesforce’s official logo asset](https://www.salesforce.com/content/dam/sfdc-docs/www/logos/logo-salesforce.svg). External links should use absolute HTTPS URLs without credentials. Changes to copy, links, logos or availability take effect with the next website publication.

### Screenshots

Detail entries include an ordered `screenshots` array. Add images under `static/integrations/screenshots/` and set each entry's `src` to its `/integrations/screenshots/` URL, with descriptive `alt` text and the image's intrinsic `width` and `height`. Replace the sample SVG screens with actual product screenshots when available. The gallery appears above Overview, supports horizontal swiping and side-mounted previous/next chevrons, and preserves the full image inside a 5:3 frame. An empty array hides the gallery; a single image hides the navigation controls.

## UI

The admin-only Integrations header tab opens `/integrations` and stays selected on detail pages. The catalog uses Settings’ centered layout and shows every entry in catalog order. Search filters names and summaries locally, ignoring case and surrounding whitespace, with an empty state for no matches. Installation changes update badges and actions without resetting the search.

`useIntegrationCatalog` reads the existing shared connection subscription. Static catalog information remains visible while connection status loads or fails; checking, errors and retry appear locally above the list. The page reports presentation success independently of connection readiness. `IntegrationCatalogSkeleton` supplies the catalog route’s startup layout for known admins; Home’s skeleton contains only contracts.

The generic detail route keys its component by slug. Both views react to admission changes, and detail lookup reacts to the current slug. Detail breadcrumbs and unavailable-entry recovery return admins to `/integrations`. Non-admin users see an access message with a Home link.

Detail pages and their loading skeleton use a centered, 1200px column with screenshots above the description. There is no metadata sidebar.

## Transition and release

Before the first static-catalog website publication on each target, read its existing stored catalog and compare all editorial content, visibility and order with the shared code snapshot. The previous seed inserted missing entries without replacing existing edits, so the former seed fixture alone cannot establish parity. Reconcile differences into the intended shared catalog before publication.

Ordinary releases deploy Convex before publishing the website, and older served pages or open tabs may still call the previous catalog APIs. Establish whether any supported clients need those APIs before deploying their removal. If consumers remain or their status is uncertain, first publish the static frontend through a temporary release retaining the old catalog backend and schema, then remove that backend after those clients retire. See [production releases](deployment.md) for the release sequence.

Removing the schema declaration does not delete legacy stored catalog records. Physical cleanup is optional, separately scoped housekeeping; it is unnecessary for the application catalog to be independent of Convex. No deployment or remote cleanup is implied by the source change.

## Validation

Use scoped formatting checks, `npx convex codegen --typecheck enable` for generated backend types without deployment, and `npm run build` for Svelte/type checks and the production build. Review content, unique slugs/section keys, links and logo files. Browser layout, focus, Show more, direct routes and live access transitions require manual review. The HubSpot entry has the live connection behavior described in [the HubSpot runbook](hubspot.md); HubSpot Quotes is a separately installed add-on; the remaining entries are Coming soon.

## HubSpot connection

The HubSpot header uses Install, Installed, Reconnect and Uninstall HubSpot instead of Website and HubSpot Support. An admin connects one HubSpot account for the workspace. Installed workspaces require a deal for new contracts; creation, first association of existing contracts and unavailable-link repair share a searchable picker showing at most three deals. A confirmed deleted/inaccessible deal blocks new edits, reviews and downloads until replacement. Temporary outages pause provider access without clearing the association or making manual creation available. Viewing, deletion, repair, accepted retries and already initiated download acknowledgments retain their authorization rules. Current company editors can repair unavailable links inside the open contract; cards do not show deal-link callouts. First association and relinking rename the contract to match the selected deal’s verified name and send future activity to that deal. Content and approvals remain intact. Contract metadata is projected into the existing directory; browsing does not hydrate snapshots or call HubSpot per card.

Admins can uninstall even when reconnect is required. Local removal immediately restores manual creation and stops syncing while preserving contracts, drafts and approvals. Queued activity is retired without replay. Shared HubSpot accounts are disconnected only for this workspace. Persistent removal status distinguishes provider success from manual attention; reinstall uses a fresh installation identity and requires explicit deal links.

See [HubSpot setup, delivery and recovery](hubspot.md) for OAuth configuration, activity scope, retention, validation and rollback.

HubSpot activity uses the durable local outbox with direct Workpool execution. Unavailable link generations stay paused; original uncertain writes can reconcile without moving history to a replacement. Export retry lasts one hour from reservation, separately from the upload hold; complete ordered selection/review provenance is retained. The runbook describes physical cleanup grace and the development-specific executor cutover.

## HubSpot Quotes

`hubspot-quote` uses the same details header and typed uninstall modal as HubSpot. It requires the normal integration in the same account and requests only the two supplemental quote scopes. Catalog installation state comes from the safe shared connection subscription, independently of current feature flags. Uninstall stays available during reconnect or a kill switch.

For installed workspaces, the contract download tool becomes **Push to HubSpot**. It creates a native draft with the full resolved contract in Terms and its existing deal. Users finish pricing, line items, recipients, signatures, payments and publishing in HubSpot. Uninstalling only Quotes restores DOCX downloads and preserves the base integration and provider quotes. Removing the base integration also disables Quotes.
