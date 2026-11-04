# Sign-in performance

**Historical implementation/evidence record, superseded for current backend instructions on 2026-10-30.** The [current architecture](backend-redesign/architecture.md), [17D2 local evidence](backend-redesign/phase-17d2-cross-workflow.md) and [Phase 18 activation procedure](backend-redesign/phase-18-activation.md) own present behavior/status. Older counts, formatting, indexes, attribution, probes and deployment results below describe their original revision; they do not certify the changed backend or authorize an old rollout recipe.


Updated on October 9, 2026. Application changes are implemented and verified locally. Production has not been deployed or measured. The measurements below were collected on October 8, before the route split described in [Account entry and workspace routes](account-routes.md).

## Resulting behavior

Login and signup render the editable email form in the server HTML. Hydration enables submission once an email is entered; it does not wait for Clerk. Typing and focus before hydration survive hydration. Native email validation still applies.

The root provider starts Clerk from an asynchronous script and preconnect in the HTML head. It exposes session context, readiness, a cancellable readiness promise, and explicit retry. It loads no Clerk UI and uses script events rather than polling. Script and session initialization share a 15-second deadline.

Submitting while Clerk is starting shows “Connecting…” and queues one submission. When Clerk becomes ready, it proceeds automatically and shows “Sending…”. A failed connection preserves the email and exposes “Try again”. Retrying the SDK does not send an email automatically; authentication mutation failures also require an explicit resubmission. Leaving the flow cancels queued work, stale responses cannot advance it, and an existing session takes priority over email or invitation submission. Authentication mutations remain serialized.

Ordinary `/login` and `/join` requests bypass the server Clerk handshake and use `Cache-Control: private, no-store`. Clerk callback parameters still use its server handler. An anonymous root document request with no authentication artifacts redirects directly to `/login`. Cookie presence selects that route only; protected layouts and API handlers still verify authentication.

The root owns Clerk readiness, startup preparation, and the persistent session controller. A lazy authenticated account host owns Convex, account preparation, and membership cache identity across entry and workspace routes. The root session retains cache cleanup across navigation; the membership-admitted workspace owns its chrome, document resources, and editors. Public authentication routes disable link preloading. Their initial static JavaScript graph does not import the Convex client or workspace document/cache modules; anonymous invitations also defer Convex through lazy resolution code. Code requests preload the authenticated account host and requested route without mounting them or starting queries. Direct protected loads start the same downloads while Clerk connects. Workspace, Home, and document destinations preload their corresponding dynamic modules; invitation and onboarding destinations avoid workspace imports.

## Local measurements

| Measurement                                 |     Before |     After |
| ------------------------------------------- | ---------: | --------: |
| Fresh browser cache: hydrated form          |   1,163 ms | 98–165 ms |
| Warm navigation: hydrated form              | 265–269 ms | 60–103 ms |
| Fresh browser cache: first contentful paint |          — |  36–60 ms |
| Fresh browser cache: HTML response          |     591 ms |  23–29 ms |
| Fresh server-side Clerk redirects           |          3 |         0 |

These are small headless Chrome development samples with Vite already warm. Hydration is the point at which the form's client handler is mounted, not completion of Clerk authentication. Clerk can still take longer to connect; that work now runs alongside the form. The initial batch also confirmed an anonymous root request uses one direct redirect to login and makes no workspace module requests.

A cold-browser-cache check immediately after restarting Vite hydrated in 327 ms, despite painting in 36 ms. That load exceeded the 250 ms target. One confirmation warm navigation took 103 ms, slightly exceeding the 100 ms target. These observations establish a substantial improvement, not a guarantee for every development load. Production, slower devices, and latency percentiles remain unmeasured.

The Clerk development SDK can perform a later document reload during its browser handshake. The confirmation batch captured initial hydration before that reload and closed each tab immediately. The retained [browser report](performance/sign-in-browser.json) contains numeric timing and sanitized check results, without account identifiers or request tokens.

## Production JavaScript graph

| Public sign-in static JavaScript |  Before |   After | Reduction |
| -------------------------------- | ------: | ------: | --------: |
| Raw bytes                        | 213,445 | 164,889 |    22.75% |
| Gzip bytes                       |  76,494 |  60,933 |    20.34% |
| Unique emitted files             |      19 |      16 |         3 |

The [optimized manifest snapshot](performance/sign-in-optimized.json) walks unique static imports from the root layout and login page, generated client nodes `0` and `11` in that October 8 build. The current route graph also includes the entry layout, and route ordering has changed; do not use those historical node IDs for a new measurement. Gzip is summed per emitted file. Dynamic imports, the separate entry runtime, CSS, fonts, and the hosted Clerk SDK are excluded. This is a dependency-graph comparison, not total browser transfer or production latency.

## Verification

`npm run verify` passed: all 24 existing performance tests, Svelte/type checking with zero errors or warnings, and the production build. Existing saving, scheduling, caching, creation, and startup assertions were preserved; no tests were added or expanded for this change.

Review fixes make a redirect back to sign-in fail the navigation attempt so the existing retry can start a fresh request. Losing the session cancels pending work and clears the opening state. Empty invitation parameters follow ordinary email signup. The persistent root session controller does not retain sign-in navigation methods, flags, or retry branches. These fixes passed `npm run verify` and source review; their component behavior has not been checked in a browser.

Temporary Chrome DevTools Protocol checks verified pre-hydration typing, delayed-SDK submission exactly once, cancellation when switching flows, and an SDK failure followed by explicit retry without automatic email submission. Live development Clerk checks verified email/code login, email/code signup, existing-session restoration, safe local return destinations, rejection of external return destinations, ordinary logout, and one invalid invitation-ticket attempt with an inline error. No uncaught exceptions were observed. No browser framework or committed browser automation was added.

Current route-level browser checks, including account switching, are recorded in [Account entry and workspace routes](account-routes.md). Valid invitation acceptance, session expiry with pending edits, and logout cancellation/discard have not been rehearsed for this refactor. The existing performance suite checks its current automated guarantees and does not directly cover all new readiness and cancellation paths.
