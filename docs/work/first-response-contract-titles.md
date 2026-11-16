# Contract titles in the first response

## Desired result

The first HTML response contains the title for the view the request will actually show. Hydration must not replace it with a temporary title. During client navigation, the old page keeps its title until the destination route has resolved; the destination then commits with its final title. Buyer preview is an explicit, immediate client-side view change.

## Title rules

| View | Final browser-tab title | Source |
| --- | --- | --- |
| Saved contract with a buyer name | `Negotiate with [buyer name]` | Authorized current saved contract |
| Saved contract whose buyer name is genuinely absent | `Negotiate a contract` | Authorized current saved contract with `buyerName: null` |
| Anonymous buyer link, or signed-in account that is not a member of the seller's company | `Review your contract` | Current public link and verified audience |
| Seller opening their company's buyer link, with a buyer name | `Leave comments for [buyer name]` | Current published link and verified company membership |
| Seller opening their company's buyer link, with no buyer name | `Leave comments` | Current published link with `buyerName: null` and verified company membership |
| Seller choosing buyer preview | `View contract as buyer` | Explicit local preview state; refreshing returns to the verified seller view |
| Missing or inaccessible saved contract | `Contract not found` | Authorized saved-contract lookup reports absence |
| Revoked or invalid buyer link | `Link unavailable` | Public link lookup reports absence |
| Saved-contract read failure | `Couldn’t load contract` | Required route read fails; render an error state |
| Buyer-link read failure | `Couldn’t open contract` | Required route read fails; render an error state |
| Account verification failure on a buyer link | `Couldn’t check your account` | Seller identity cannot be determined; render the account error state |

The generic titles in the two `buyerName: null` rows are terminal titles for records that really lack a name. They must never be used while an available buyer name is still loading. Contract creation, template authoring, and contract settings retain their existing static titles.

`/<code>`, `/<code>/contract`, and `/buyer/<token>/contract` use the same buyer-link rules. The legacy `/buyer/<token>` and `/buyer/<token>/details` routes redirect, so their destination supplies the title.

## Starting data path and gaps

- A saved contract's buyer name comes from `contractBuyer.buyerName`: manual contracts use `savedContracts.title`; linked contracts use the linked buyer company's name or `null`. `contracts.routeTitle` already authorizes the read, but returns `null` for both an absent contract and a valid contract without a buyer name. The route must return distinct outcomes.
- The saved-contract server page currently resolves this name only for a full HTML request. It skips the read for a client data request, where the root layout guesses from a local cache or shows `Negotiate a contract`. `SavedContract` later publishes another title after its live metadata arrives.
- A buyer link's public `buyerLinks.status` reads the current published view, including `buyerName`. `buyerLinks.sellerContext` checks the authenticated account's membership in the link's company. That membership, rather than a cookie or an account session alone, determines the seller title.
- The buyer route still sends only a cookie-presence hint from `+layout.server.ts`. `hooks.server.ts` bypasses Clerk middleware on buyer paths but now provides a private, request-scoped account credential function to server loads. No route load uses it yet. `BuyerShell` starts with `Contract`, then changes the title after client-side status and seller-context reads.
- The root layout and `RouteTitle`/`PageMetadata` compete to set the browser title. The destination guess, buyer-name cache, and component override all need to give way to one resolved route title when the later phases are implemented.

## Implementation constraints

The required route reads should use small current records, not wait for the document, avatar, highlights, or footer. A title lookup failure must not silently turn into a generic success title. Keep the title outcome tied to the same current contract or link state used to admit that page, so a separate read cannot fail independently or supply an obsolete name. Resolve identity and public link state in parallel where possible, then decide the audience from verified membership.

## Phase 2: request-scoped account credential

Buyer page requests now expose a lazy `locals.buyerPageCredential()` to server loads. It returns `anonymous` immediately when there is no account artifact, `account` only after Clerk authenticates the session and issues a Convex token, or `unknown` if an apparent account cannot be verified. The credential stays on the server and is not included in layout data. The existing public buyer-link middleware bypass and its response headers remain in place. The route uses that credential for a query with the same verified company membership policy as `buyerLinks.sellerContext`; Clerk sign-in alone does not determine the seller title.

## Phase 3: required route outcomes

The saved-contract server page now reads a current authorized title outcome for both HTML requests and client navigation. The query distinguishes an accessible contract with `buyerName: null` from an unavailable contract. Failed reads are separate error outcomes.

The buyer layout now resolves a private page credential, then reads a single current link snapshot and verified audience through `buyerLinks.pageContext`. That query uses the same company membership and live-contract conditions as `sellerContext`, so a signed-in account outside the seller company remains a buyer. The server returns the final title and audience, or a distinct link, read, or account error. Credentials stay private. The root layout and component title setters still own display during this phase; the next phase will consume these route outcomes and remove their old guesses.

## Phase 4: one title renderer

The root layout now renders saved-contract and buyer-link titles from the committed `resolvedRouteTitle` route data. Pending client navigation leaves the old route and title in place until the destination commits. The saved-contract buyer-name cache and the saved and buyer live title setters are gone. Seller buyer preview remains an explicit local title override and can change immediately without a route load. Other account-flow title overrides still use the root layout's single `<title>` element.

An unavailable or failed server route read now renders its matching error view instead of admitting the contract viewer under an error title. The error views can retry the route read. The route data no longer carries a separate `contractBuyerName` field.

## Phase 5: first-response audit

A local HTTP request against a controlled current buyer-link response returned `<title>Review your contract</title>` in the initial HTML. The same resolved title appeared in SvelteKit's serialized route data, so hydration receives the value used by the server render. An uncredentialed saved-contract request correctly redirected to sign-in and returned the sign-in title. The production build and type checks passed.

At the time of the initial HTTP check, the configured Convex deployment did not yet contain `buyerLinks.pageContext` or `contracts.routeTitle`. The user subsequently confirmed that the intended titles work in the app. Authenticated first-response HTML and hydration were not independently inspected after that update.
