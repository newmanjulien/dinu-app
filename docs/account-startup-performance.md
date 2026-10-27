# Account startup cleanup

Updated on October 25, 2026. The backend changes and contract-directory backfill are on development deployment `scrupulous-squirrel-986`. Production has not been deployed or measured. [Account entry and workspace routes](account-routes.md) describes the route architecture; the earlier measurements below describe the preceding implementation.

## Resulting startup path

The root owns Clerk readiness, a persistent session controller, and startup preparation that warms an unused Convex connection during email verification or while authenticated account code loads on a direct workspace visit. A failed account-code load closes the warmed connection; a retry can warm a fresh one. Revisiting the workspace with that account already mounted does not create a spare connection. Public login and signup render their email form before Clerk is ready and own a replaceable navigation attempt with a safe local `returnTo`. A lazy authenticated account host owns the transport, live viewer, and membership cache identity across entry and workspace routes. The workspace layout separately admits company members and owns document and editor resources. Entry screens share the login shell without workspace chrome. Protected workspace routes use lightweight page skeletons during account and workspace admission, with no minimum display time. Other loading surfaces retain the shared loading wheel. Home appears when authentication, membership, and its code are available; the contract list loads independently.

`WorkspaceSkeleton` selects Home, Admin/new/saved documents, Settings, or Team from the route ID without importing their data or editor components. A generic header placeholder appears before account admission; the real shared header replaces it after membership admission. Home reuses its responsive card skeleton while the first list loads and keeps existing cards during refresh/search. Team replaces only the missing colleague or invitation rows, independently, after its real controls mount. Settings has only a startup skeleton because its values already come from the admitted viewer. Documents share a paper skeleton through module, data, and pagination loading; embedded variants omit the surrounding heading and utility placeholders. Baseline setup, retained visible viewers, errors, and retry/logout controls keep their existing paths. Placeholders are decorative and noninteractive, with a single loading announcement and reduced-motion support. Svelte/type checking and the production build passed; visual handoffs and perceived speed have not been checked in the browser. No tests were added, and saving, caching, and scheduling were not changed by the skeleton implementation.

Contract help belongs to `WorkspaceChrome` in the resolved document workspace. Admin and saved-contract guides wait for prepared, visible content and retain their per-variant “Don't show this again” preference. Loading, missing-contract, and failed-opening views cannot display help. The naming form can mount before the document host; saved-contract and fallback preview code load separately. The name remains editable while Create waits for the host, and the shared paper skeleton covers both missing draft data and viewer preparation. The saved workspace is admitted only after the creation handoff closes the naming dialog, including after an opening retry. No shell help context or modal hold counter is needed. Browser layering and perceived timing remain unverified.

The surface disables its animation for reduced motion, reports errors inline, and exposes retry/logout controls after 10 seconds. Once admitted, the authenticated account subtree remains mounted and inert during connection recovery. Existing editor suspension, pending-save handling, and logout guards remain in place.

The protected server layout performs the authentication guard and safe login redirect, with `Cache-Control: private, no-store`. On a direct signed-in Home request, the page starts a read-only `profiles:startup` query for the compact viewer and first 24 contract cards. Its promise streams without holding up the route response, overlapping Clerk startup, code loading, and the browser's backend connection. Token lookup and the query share a five-second budget; failure falls back to live subscriptions. In-app data requests skip this extra query. Tokens are never serialized into route data.

The initial result can assist an already initialized account only after browser Convex authentication succeeds. It must match the current Clerk user, session, and first transport generation. Live viewer results and errors take precedence, and a replacement transport cannot reuse it. Initial cards must also match the admitted profile and membership; search or a live page supersedes them. Load-more waits for live pagination. Home browsing uses the [contract directory](contract-directory.md), which separates compact card metadata from full saved selections and review state. The optional delegation widget loads after the first usable workspace frame on desktop-sized screens, and its modal loads when opened. Once eligible, it stays mounted through resizes.

The browser uses the authenticated live Convex viewer as its account preparation source. A confirmed missing-state result permits initialization once per transport generation. Returning accounts remain read-only until initialization is confirmed necessary. Retries replace the transport and reread the live viewer before deciding whether initialization is still needed. Convex authentication is configured once per session and transport generation; unrelated Clerk resource updates leave the transport intact, and token refresh reads the current session resource. Home admission does not wait for the paginated live result. Contract-list requests have their own 15-second loading deadline, reset by a new search or transport generation; late successful results clear the local failure. The obsolete card cache reader, writer, validator, and rename/delete reconciliation are removed; account-isolated opening history remains.

The document renderer is dynamically imported when a document route needs it or background warming is allowed and has preparation candidates. Admin document queries belong to the Admin route. Opening Home does not start preparing the Admin document. Saved-contract warming begins after the live list settles, workspace admission, two animation frames, and an idle callback, with a bounded fallback. Up to four visible contracts may download snapshots, but only one eligible candidate is selected for background document construction and measurement. Failed candidates are filtered before that slot is assigned; completing one candidate does not prepare the whole ranking serially. Card updates coalesce into one ranking pass per update batch, and unchanged candidate ordering does not republish downloads. Data-saving connections limit downloads to one. Devices reporting at most 4 GB of memory or four logical processors, and data-saving connections, prepare only a hovered or focused candidate. Existing retention limits and protected foreground/draft resources remain unchanged.

Background work pauses during search, list loading, navigation, recovery, teardown, a hidden tab, and scrolling or typing. Interaction resumes after 250 milliseconds of quiet. Pausing cancels active speculative reads, and changes to download candidates cancel reads that are no longer selected, without treating either cancellation as a preparation failure. Explicit document navigation keeps priority, and retained document ownership remains layout-scoped. Foreground snapshot loads additionally cancel unrelated background reads; a healthy matching flight is claimed before the pause and reused with its original deadline. One-shot Convex reads release their subscriptions on success, failure, timeout, or cancellation. A shared version read continues while at least one consumer still needs it. Dynamic imports already started cannot be cancelled, so eligibility is checked before starting them.

Navigation, Clerk loading, authentication, account preparation, document module loading, and document opening have 15-second read deadlines. The opening deadline runs until the workspace reports visibility or failure, including seeded creation handoffs waiting for fresh metadata; it is independent of snapshot availability. A new transport generation restarts a failed opening, while a workspace that already opened stays mounted. Snapshot flights have a 15-second total budget, including a 250-millisecond IndexedDB read budget before network fallback. Dependencies that ignore cancellation cannot leave callers waiting indefinitely or publish late snapshots.

Optional disk writes are coalesced per contract in a queue bounded to 24 pending operations and 32 MB of snapshot/metadata payloads, including active writes. Each queued batch uses one transaction and one eviction pass over compact LRU index keys, rather than loading full contract state for every write. A pending metadata update merges into a pending snapshot write; deletion supersedes pending content. IndexedDB opening has a 250-millisecond deadline and transactions have a one-second deadline. Teardown clears pending writes and aborts active transactions. These limits apply only to the optional cache, not server mutations or draft recovery. Disk contract reads load metadata only; immutable content from disk or the network goes through the same shared version loader. Clean reads use read-only transactions. Corrupt records are rechecked in a separate write transaction before deletion, preserving newer valid replacements. Template validation is reused only for the exact immutable object and company; contract identity and state validation remain separate.

Sign-in retries replace failed navigation attempts, including a protected-route redirect back to sign-in. Once the authenticated account host mounts, retries replace authentication transport, cancel pending snapshot reads, and preserve confirmed cache entries. Unresolved documents retry after authentication succeeds; admitted editors remain mounted. Saving and logout have no new deadlines: pending-save confirmation, cancellation, and discard behavior remain separate from read attempts.

The root uses a small Clerk session provider with Clerk's public script loader and session APIs. `svelte-clerk` 1.2.0 passed `Promise.resolve(undefined)` as its UI constructor when `prefetchUI=false`; ClerkJS 6 then rejected with `TypeError: e is not a constructor`. The session provider omits the unused UI option entirely and retains the context required by the existing hooks. `@clerk/shared` is a direct, pinned dependency at 4.39.0. Future Clerk upgrades should recheck login, signup, session changes, and script-load retry.

## October 25 implementation cleanup

All 20 review findings are covered by the five implementation changes below. The
UI and interaction behavior are preserved. The optional IndexedDB cache format is
now version 5; upgrading rebuilds that cache once to add its compact LRU index.
Server data and draft recovery are unaffected.

| Finding                                               | Implemented resolution                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1. Active downloads continue through a pause          | Pause aborts background flights without preparation failures.                                                              |
| 2. Failed account code leaves a warmed connection     | Failure cancels preparation and prevents warming again until retry.                                                        |
| 3. Failed first candidate blocks preparation          | Failure filtering precedes the one-slot selection; that target gets download priority within the existing download budget. |
| 4. Temporary deletion hold stops backfill permanently | Preparation/dispatch keeps a delayed continuation with the same cursor; confirmed cleanup terminates it.                   |
| 5. Cancelled one-shot queries remain subscribed       | `queryOnce` owns unsubscribe and listener cleanup on every settlement path.                                                |
| 6. Speculative document imports bypass pause          | The speculative host import requires the existing background permission.                                                   |
| 7. Disk hits bypass shared versions                   | Disk contract metadata and network state both resolve content through `loadVersion`.                                       |
| 8. Seeding revalidates immutable content              | Validation is memoized by exact template object and company, while contract validation stays separate.                     |
| 9. Unchanged candidate arrays trigger work            | Download ordering and resource ranking only publish changes.                                                               |
| 10. Hidden mobile widget code downloads               | Initial import uses desktop eligibility, latched to preserve mounted state through resizing.                               |
| 11. Home has unreachable optional-client branches     | Home uses its required workspace client and removes the nullable branches.                                                 |
| 12. Startup rereads the company                       | Directory reading accepts only the company ID/readiness already obtained by the authorized viewer read.                    |
| 13. Documentation references the deleted endpoint     | Endpoint, token-response, and obsolete timeout descriptions are removed.                                                   |
| 14. Clean disk reads acquire write locks              | Metadata and version reads use read-only transactions; repair rechecks separately under a write lock.                      |
| 15. Every disk write scans full contract state        | Queued writes share a transaction and eviction uses compact index keys, sizes, references, and recency.                    |
| 16. Each card update reranks the full list            | Updates coalesce into one ranking pass per microtask batch.                                                                |
| 17. Home duplicates pagination retention              | Library retention is removed; Home retains its existing bootstrap/live transition and previous cards.                      |
| 18. Independent viewer reads run serially             | Template pointer, avatar URLs, and deletion state load together after authorization prerequisites.                         |
| 19. Snapshot loading has an unreachable error branch  | Errors use the existing catch path; the dead branch is removed.                                                            |
| 20. Version flights start with a dummy result         | Flights are constructed with their actual work promises.                                                                   |

`npm run verify` passed all existing 20 lifecycle and 24 performance tests, Svelte/type
checks, and the production build. The separate Convex type check and development
push also passed. The caching fixture now supplies cancellable subscriptions;
existing assertions and their guarantees were retained. These checks cover network,
memory, and disk reuse, immutable-write counts, confirmed revision/deletion behavior,
saving/creation work, and existing scheduling guarantees. No tests were added.

The new pause/foreground handoff, failure selection, corruption repair, responsive
import eligibility, and deletion-hold continuation were reviewed in code and compiled;
they have no new dedicated automated coverage. Browser latency and behavior remain
unmeasured for this cleanup. Backend fixes are deployed to development deployment
`scrupulous-squirrel-986`; the frontend is local and production has not been deployed.

## Earlier bundle measurement

| Dashboard static JavaScript |  Before |   After | Reduction |
| --------------------------- | ------: | ------: | --------: |
| Raw bytes                   | 424,141 | 312,378 |    26.35% |
| Gzip bytes                  | 145,709 | 111,487 |    23.49% |

The snapshots are [baseline](performance/account-startup-baseline.json) and [optimized](performance/account-startup-optimized.json). The analyzer walks the unique static imports of SvelteKit's root layout, workspace layout, and Home page in the production manifest. Gzip is summed per emitted JavaScript file. Dynamic imports, the separate entry runtime, CSS, fonts, and hosted Clerk assets are excluded. These figures describe that static dependency graph, not total browser transfer or a measured latency improvement. Saved-contract warming may load document code after admission on a populated dashboard.

Reproduce after `npm run verify`:

```sh
node scripts/account-startup-bundle.mjs /tmp/account-startup-bundle.json
```

The script discovers those nodes by source path, so route-group ordering does not require hardcoded node IDs. The authenticated account, workspace, and Home components load dynamically. This script measures the static route shell and excludes their dynamic modules; its output cannot be read as the complete workspace download.

## October 9 review fixes

Account entry and the workspace now have separate route groups and separate admission requirements. The root session controller persists across both groups. Authenticated account code loads independently of the workspace; only a membership-admitted workspace mounts its header and document resources. The account owns cache identity, with root-session cleanup, so entry navigation preserves snapshots and opening history. Company setup and invitation resolution stay in the shared login presentation. See [Account entry and workspace routes](account-routes.md) for ownership and navigation.

Code requests preload the authenticated account host and requested route, with Workspace and Home imports for workspace/Home destinations. Invitation and onboarding destinations avoid those workspace imports. Signup warms onboarding during verification, then the admin setup route after onboarding paints. It does not speculatively download Home. Baseline-dependent routes leave editor and renderer loading to Workspace after baseline readiness, avoiding those downloads for a new company. These downloads overlap email verification or Clerk startup on a direct protected request without mounting components or running account queries. Anonymous invitations defer resolution code and exclude Convex from their static graph. Actual login timing and transfer cost after this route split remain unmeasured.

Initial account admission also checks the controller's admitted state, so late viewer data cannot bypass a failed read attempt. Previously admitted content remains mounted through recovery. Initial Convex authentication uses Clerk's prefetched token; cache bypass follows an explicit refresh request or a replacement transport within the same account session. The document host uses the shared component loader, including its named workspace factory, timeout, retry, and stale-result handling.

Invitation inbox reads and link resolution now have independent 15-second deadlines after account admission. Inbox subscriptions and timers run only on the join step. A recovered transport restarts their read budgets, late inbox results clear its local timeout, and replaced or timed-out link-resolution attempts cannot publish late results. Empty invitation tokens use the existing error state. The workspace boundary derives membership from the live account viewer and keys workspace resources by profile and membership. Shared component loading follows the transport retry generation; old workspace teardown cancels only its captured cache instance.

The review also restored pagination through empty live pages, added independent contract-list loading deadlines, prevented optional document-host failures from blocking template preparation screens, closed warmed connections after failed code requests or invitation acceptance, and removed redundant auth-shell configuration and conditions. The existing 24 performance tests, Svelte/type checks, and production build passed. No tests were added. Current route-level browser checks are recorded in [Account entry and workspace routes](account-routes.md). Live login timing, network-stall recovery, failed chunk loading, and populated pagination remain unverified in the browser.

## Earlier browser observations

Before this recovery refactor, the Clerk provider was exercised through normal email/code login and signup using Clerk's official development testing-token mechanism and development test addresses. A body-change observer and browser network events were used directly through Chrome DevTools Protocol. No browser test framework or additional committed browser tests were added.

| Flow            | Server bootstrap duration | Accepted auth to usable dashboard | Accepted auth to paint marker |
| --------------- | ------------------------: | --------------------------------: | ----------------------------: |
| Returning login |                  322.7 ms |                          532.4 ms |                      552.7 ms |
| New signup      |                  878.3 ms |                        1,081.3 ms |                    1,106.3 ms |

Each row is one warm development-browser observation with an empty dashboard. Time spent entering email or waiting for a code is excluded. The paint marker runs after two animation frames; it is an application marker, not a browser-reported pixel-paint measurement. There is no comparable authenticated baseline, production sample, median, or p95.

Both flows showed the auth form, its submission state, the shared startup surface across navigation, and then the complete empty dashboard. The observed dashboard live query paths were `profiles:viewer` and `savedContracts:browse`. No Admin queries, document-host/renderer modules, or uncaught exceptions were observed in the final login/signup checks. Logout returned to the login form.

Direct Settings and Admin navigation were checked before the final Clerk provider replacement. Settings loaded without document code. Admin loaded its document host and editor on demand. Their observed live queries included the viewer and Admin's `contract:getBlocks`/`playbookItems:list`; neither deep route fetched `savedContracts:browse`.

With the Clerk script deliberately delayed, Home showed the startup surface, an unanimated loader under reduced motion, and retry/logout controls after 10 seconds. The SDK's script timeout subsequently produced the inline sign-in load error. Clicking retry after removing the delay reached the dashboard successfully.

## Verification of the recovery refactor

`npm run verify` checks the existing lifecycle suite (20 tests), five performance test files (24 tests), Svelte/type checking, and the production build. The startup tests preserve returning-account read-only behavior, one-time missing-state initialization, and no attribution rescheduling. The affected saving and creation fixtures include directory entries: unchanged saves still perform zero writes; changed saves retain one contract write and additionally maintain compact directory metadata; creation retains two contract/receipt writes and adds one directory write without template-content reads or compilation. Existing caching and scheduling assertions remain intact. No tests or browser automation were added for the October 25 changes.

The directory backfill completed for both development companies. The server-bootstrap identity checks, pagination source transition, adaptive preparation policy, and deferred widget/modal were reviewed in code and compiled, but have no new dedicated automated coverage or browser timing samples. The earlier measurements below and above do not establish the speedup from these changes.

During the earlier recovery refactor, browser automation was stopped at the user's request. The subsequently authorized sign-in implementation has its own completed targeted browser checks in [Sign-in performance](sign-in-performance.md). Before it stopped, baseline collection captured four email/code logins before Clerk rate limiting and 25 authenticated dashboard reloads. Document baseline collection and an optimized comparison were not completed. These partial development samples do not establish a before/after median, p95, or latency improvement; earlier measurements above describe the earlier implementation only.

The new timeout, cancellation, stale-attempt, and session recovery paths were reviewed in code but have no dedicated automated coverage. Populated dashboard search/pagination, rename/delete, large/direct document opening, session expiry with pending edits, and logout cancellation/discard remain unverified in the browser after this refactor. Production and slower-device performance remain unmeasured.

Startup instrumentation is enabled in development or with `PUBLIC_CONTRACT_PERF=1`. `window.__accountStartup` retains at most 100 entries containing an event name, numeric attempt ID, and numeric timing. Events include `sign-in-hydrated`, `clerk-script-available`, `clerk-ready`, `auth-accepted`, `navigation-started`, `usable`, and `dashboard-painted`; the obsolete server bootstrap marker is removed. Entries contain no tokens or account identifiers.
