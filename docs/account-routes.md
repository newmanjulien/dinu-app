# Account entry and workspace routes

Updated October 10, 2026. This describes the current route and session architecture. Route groups do not change public URLs.

## Route ownership

| Layer                 | Owns                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Root layout           | Clerk readiness, persistent session controller, startup preparation, lazy authenticated account host                   |
| Authenticated account | Convex transport, live account viewer, missing-profile initialization, recovery, account and membership cache identity |
| `(entry)`             | Shared login presentation for `/login`, `/join`, and `/invitation`; signed-in identity and account switching           |
| `(onboarding)`        | Grey full-page presentation for `/onboarding`; account authentication without workspace chrome                         |
| `(workspace)`         | Membership admission, document and editor resources, app header and workspace routes                                   |

Account authentication and company membership are separate requirements. The root does not render an app header. Login and invitation screens use the same responsive shell whether the visitor is signed out or already authenticated. Onboarding has its own presentation and uses the same root account/session providers. These screens do not import the workspace to hide its chrome.

The authenticated account host mounts after Clerk supplies an identity. It remains mounted when moving between invitation/onboarding and workspace routes for the same session. Switching sessions destroys the old account host. The root session controller persists across those route changes and coordinates recovery, logout, account deletion, and registered editor/resources without importing workspace caches into the initial login graph.

`AccountGate` owns the live `profiles.viewer` subscription. Only a confirmed missing-state result permits profile initialization, once per transport generation. Account readiness admits signed-in entry screens; membership is not required. Temporary connection failure retains the admitted account subtree and blocks interaction while recovery runs.

`AccountGate` sets the cache identity from the confirmed viewer before workspace children mount. Account or membership changes release the old snapshot cache and discard its persistent namespace. The root session owns cache cleanup on logout, account switching, and teardown; its resource registration survives route changes. Navigation to entry screens preserves confirmed snapshots and opening history.

`WorkspaceBoundary` requires a live profile, membership, and company. `WorkspaceScope` is keyed by profile and membership and supplies only viewer context. Each workspace captures its own cache instance, cancels its pending reads, and destroys its document resources on teardown; an old workspace cannot cancel a replacement's cache. Membership loss clears the previous membership's draft journal and removes the workspace. Role changes preserve its identity and mounted drafts.

## Entry presentation and onboarding

`(entry)/+layout.svelte` owns the shared `AuthEntryShell` and signed-in footer for login, signup, and invitation. The shell owns the responsive card, content width, footer placement, and testimonial background.

`(onboarding)/+layout.svelte` owns onboarding's full-page grey background and blue button variables. The public URL remains `/onboarding`; its server authentication guard and private, uncached responses are preserved. The flow supplies the centered content, create-step Back action, and signed-in footer with Sign out disabled during a pending action or blocked session. `OnboardingStepFrame` supplies the shared heading and description spacing. Selection uses two illustrated white cards side by side on desktop and stacked on mobile. Create uses a narrow centered form; join uses white invitation cards and an empty-inbox invitation box, followed by Create a company instead. Shared entry inputs and buttons remain reusable, without return badges.

`/onboarding` requires an admitted account and mounts `auth/onboarding/OnboardingFlow.svelte`. The flow owns the current step, retained company-name draft, mutation state, stale-session protection, and workspace completion navigation. `ChooseCompanyStep` and `CreateCompanyStep` render their fields and actions through callbacks. `JoinCompanyStep` owns its live inbox subscription, read deadline, and retry UI, so those resources exist only while that step is mounted.

Confirmed live membership triggers completion after any pending mutation settles and while the session is ready. Each mounted flow attempts workspace navigation once; cancellation or failure does not trigger automatic retries. Mutation and navigation errors from blocked or replaced sessions are ignored.

Today, creating or joining a company completes onboarding. Future setup steps, such as template upload, belong in this flow and can reuse the onboarding presentation. When a step must continue after membership is established, extend the flow's completion rule and the workspace admission rule together so reloads and direct workspace visits preserve that requirement. Template upload and persisted progress are not part of this change.

## Navigation

- Signed-out workspace requests redirect to `/login` with a safe local `returnTo`.
- Signed-in accounts without a company go to `/onboarding`, preserving the requested workspace destination.
- Company creation or explicit invitation acceptance establishes membership, then opens the workspace.
- Members visiting onboarding return to the requested workspace destination.
- `/invitation?invitation=…` stays in the entry shell for all account and membership states. Signed-out invitees verify the fixed invited email without choosing login or signup. Switching accounts returns directly to the invitation.
- A member who needs to leave a different company can open Team with an invitation return destination. Leaving the company returns to the invitation.

Server guards preserve the pathname and query; browser navigation can also preserve fragments. Return destinations reject external URLs, malformed paths, and authentication loops. Entry responses and protected redirects use `Cache-Control: private, no-store`. Invitation pages set a no-referrer policy.

## Invitation states

The server loads a minimal anonymous preview using the random invitation token. An active link reveals only the company name, invited email, and expiry; terminal or unknown links return only their status. The lookup uses an indexed token hash and has a 15-second deadline. The page offers retry after a failed lookup and stops anonymous verification when the preview expires.

The invitation shows the company and invited email, then offers **Continue** to send a code. Clerk signs in an existing account or transfers the verified email into a new account automatically. Both paths remain on the invitation and require a separate **Join [Company]** confirmation before entering the workspace. The CAPTCHA container remains mounted during verification and account creation. Authentication does not accept the invitation or open company setup.

Authenticated resolution returns available, wrong-email, other-company, already-member, accepted, expired, revoked, or unavailable states. Matching the verified email is required before invitation IDs, delivery generation, or authenticated company details are returned. Acceptance is an explicit mutation using that resolved generation; rotated invitations cannot be accepted through an older resolution.

Link resolution has a 15-second read deadline. Token changes, account changes, membership changes, transport replacement, and teardown invalidate old attempts. Acceptance tracks its own write attempt so stale completion cannot navigate another account or invitation. Writes have no new cancellation or timeout semantics; connection interruption does not cancel a server mutation.

Onboarding offers company creation and a live invitation inbox. The inbox subscription and read deadline run only while a companyless account is viewing the join step. Scheduled server mutations mark invitations expired, updating the subscription without device-clock filtering or polling. The index excludes expired invitations before company and inviter details are read. Inbox reads have a separate deadline and retry. Authentication does not automatically accept an invitation or create a company.

## Loading and recovery

Initial login HTML contains the email form; active invitation HTML contains company context, the invited email, and Continue. The anonymous preview uses a server-only Convex HTTP client. The initial static login and anonymous invitation graphs exclude the Convex transport and workspace document/cache modules. Authenticated invitation resolution code loads only for a signed-in account. During email verification, startup preparation warms an unused Convex connection and preloads the authenticated account host plus the requested route's code. Direct protected workspace loads start those independent downloads while Clerk connects. Workspace destinations also preload the workspace, Home destinations preload Home, and document destinations preload the document host. Entry destinations avoid those workspace imports. Preloading does not mount components or start authenticated queries; a verified session takes ownership of the warmed connection once.

Account admission, workspace admission, and the destination's usable marker are distinct. Workspace chrome appears only after membership admission. Home controls do not wait for contract-list results, and document routes load their renderer on demand. Account, workspace, and invitation component imports share one bounded loader with stale-result protection. A session retry clears the account read failure and restarts failed imports through the transport generation. Recovery replaces the transport while retaining admitted editors; logout and leaving a company retain the existing save, cancel, and explicit discard guards.

Invitation preview and resolution run in Convex's default runtime using Web Crypto
for SHA-256; only SMTP delivery uses Node. When the server skips anonymous preview,
the route uses the shared account-loading recovery while Clerk initializes, so a
failed initialization exposes the existing retry control.

## Verification

The restored onboarding presentation passed `npm run build` with zero type errors or warnings, targeted formatting checks, and `git diff --check`. A local browser preview of the actual onboarding layout and components checked the illustrated choice cards, create and join steps at 1440px, 640px, 390px, and 320px without horizontal overflow. It confirmed retained company-name input across Back, the white empty-inbox box and invitation cards, Create a company instead, retry callbacks, and no inbox subscription before opening join. The browser reported no errors. Account, queries, mutations, and navigation used temporary fixtures; live authentication, company creation, and invitation acceptance remain unverified for this presentation restoration. No tests were added or expanded, and the performance suite was not rerun because saving, scheduling, and caching behavior did not change.

The onboarding review fixes passed `npm run build` with zero type errors or warnings and targeted formatting checks. Isolated browser probes of the actual flow confirmed that pending writes defer membership navigation, cancelled navigation does not restart, blocked sessions prevent completion and stale errors, transport replacement ignores old mutation errors, active write failures clear pending state, and teardown ignores late completion. The probes used reactive account/session fixtures and controlled mutation/navigation promises; live authentication and server writes remain unverified. No tests were added or expanded, and the performance suite was not rerun for these navigation-only fixes.

The onboarding presentation and component split passed `npm run build`, including type checking with zero errors or warnings, and all 24 existing performance tests via `npm run test:perf`. An isolated browser preview of the actual entry layout and flow checked the screenshot's desktop composition, 390px and 320px mobile layouts without horizontal overflow, retained company-name input across Back, inbox and error presentation, retry callbacks, and workspace return destinations. Its account, queries, mutations, and navigation were fixtures; live authentication, company creation, and invitation acceptance were not exercised for this change. No tests were added or expanded.

`npm run verify` passed all 24 existing performance tests for saving, scheduling, caching, creation, and account preparation, followed by type checking with zero errors or warnings and the production build. The final dedicated invitation implementation also passed type checking and the production build. No tests were added or expanded for this flow. Earlier route-refactor runtime probes checked component retry, stale import results, loaded-module reuse, session timeout recovery, and resource clearing on account switching/logout.

The invitation backend was pushed to the development deployment `scrupulous-squirrel-986` with type checking enabled. Read-only live calls confirmed that malformed and unknown tokens return only unavailable status and that anonymous authenticated-resolution calls are rejected. Local HTTP checks confirmed missing, malformed, and unknown invitation pages render unavailable states, invitation responses include a no-referrer policy, and invitation/login responses remain private and uncached. The final production manifest confirms that both static anonymous graphs exclude the Convex transport, snapshot cache, and authenticated workspace components. Clerk's API types and implementation were reviewed for verified sign-in-to-signup transfer and CAPTCHA handling; actual email verification was not exercised.

The follow-up fixes passed `npm run verify` again: all 24 performance tests, zero type errors or warnings, and the production build. The backend push passed Convex type checking. Development expiration initialization completed; read-only inspection confirmed that every pending record was initialized and the active invitation had a matching pending expiry job. Live malformed-token, unknown-token, and anonymous-resolution checks passed in the default runtime. SMTP delivery, deadline cancellation under a live stalled connection, and scheduled expiry at the actual deadline have not been exercised.

Before the dedicated acceptance flow, the emitted production manifest confirmed that the static login and anonymous invitation graphs excluded Convex and the snapshot cache. Lazy invitation resolution removed 20,768 gzip bytes from the invitation's unique static JavaScript dependencies compared with the preceding review build. This historical dependency-graph comparison does not measure the current invitation flow's browser transfer or latency; CSS, dynamic imports, the entry runtime, and hosted Clerk assets were excluded.

Before the dedicated acceptance flow, direct development-browser checks covered anonymous invitation presentation on desktop and mobile, incomplete and unavailable invitations, account switching with an invitation return destination, companyless onboarding and its empty inbox, member workspace access, and member onboarding redirects. Review found and fixed server fragment access and duplicate login response headers.

The dedicated flow still needs live email-code verification for both existing and new accounts, explicit acceptance, wrong-email account switching, and expired/revoked links in the browser. Company creation, network-stall recovery, failed chunk recovery, and session expiry or logout with pending edits have not been rehearsed in the browser for this refactor. The suite does not directly cover every new component transition. Production has not been deployed or measured.

Earlier latency and bundle measurements are retained in [Sign-in performance](sign-in-performance.md) and [Account startup cleanup](account-startup-performance.md). They describe their dated implementations, not a measured latency improvement from this route split.
