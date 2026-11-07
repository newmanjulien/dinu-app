# Account entry and workspace routes

Updated October 21, 2026. This describes the current route and session architecture. Route groups do not change public URLs.

## Route ownership

| Layer                 | Owns                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Root layout           | Route metadata, Clerk readiness, persistent session controller, startup preparation, lazy authenticated account host   |
| Authenticated account | Convex transport, live account viewer, missing-profile initialization, recovery, account and membership cache identity |
| `(entry)`             | Shared login presentation for `/login`, `/join`, and `/invitation`; signed-in identity and account switching           |
| `(onboarding)`        | Grey full-page presentation for `/onboarding`; account authentication without workspace chrome                         |
| `(workspace)`         | Membership admission, document and editor resources, app header and workspace routes                                   |

Account authentication and company membership are separate requirements. The root does not render an app header. Login and invitation screens use the same responsive shell whether the visitor is signed out or already authenticated. Onboarding has its own presentation and uses the same root account/session providers. These screens do not import the workspace to hide its chrome.

The authenticated account host mounts after Clerk supplies an identity. It remains mounted when moving between invitation/onboarding and workspace routes for the same session. Switching sessions destroys the old account host. The root session controller persists across those route changes and coordinates recovery, logout, account deletion, and registered editor/resources without importing workspace caches into the initial login graph.

`AccountGate` owns the live `profiles.viewer` subscription. Only a confirmed missing-state result permits profile initialization, once per transport generation. Account readiness admits signed-in entry screens; membership is not required. Temporary connection failure retains the admitted account subtree and blocks interaction while recovery runs.

`AccountGate` sets the cache identity from the confirmed viewer before workspace children mount. Account or membership changes release the old snapshot cache and discard its persistent namespace. The root session owns cache cleanup on logout, account switching, and teardown; its resource registration survives route changes. Navigation to entry screens preserves confirmed snapshots and opening history.

`WorkspaceBoundary` requires a live profile, membership, and company. `WorkspaceScope` is keyed by profile and membership and supplies viewer context plus the contract editing sessions that survive route changes. Each workspace captures its own cache instance, cancels its pending reads, and destroys its document resources on teardown; an old workspace cannot cancel a replacement's cache. Membership loss clears the previous membership's draft journal and removes the workspace. Role changes preserve its identity and mounted drafts.

`WorkspaceShell` mounts the shared header and interaction dispatcher as soon as membership is admitted, including while workspace or document code is loading or has failed. Document chrome contributes its search and status content through a scoped header registration. `auth/routes.ts` supplies titles, navigation selection, baseline requirements, and document classification to both mounted routes and URL-only preload/performance callers. The root is the only title writer; entry flows can register a title override scoped to the current route. Titles therefore update at navigation commit even when an editor cannot mount, which also gives SvelteKit's navigation announcer the destination title.

`DocumentBody` gates initial body mounting on any required baseline and, by default, the lazy document host. The contracts layout opts out of the host gate so its skeletons and naming dialog can mount while document code loads; each editor still waits for the host. The persistent Admin owner mounts outside `DocumentBody`, after both its own module and the host are ready. Once mounted, a company deletion hold hides and disables the body while retaining its state. Document resources remain mounted with preparation paused; contract persistence pauses new saves, and document reads stop. Already dispatched writes keep their existing outcome semantics. Settings stays available to finish or cancel deletion, and the contract naming dialog leaves the browser's modal layer during the hold without clearing its input.

Home and Team bodies unmount during a hold, releasing their queries, shortcuts, and modals. Their route metadata and shared navigation remain mounted. The route catalog marks Settings as available during the hold.

The workspace retains an admitted Admin owner through a reversible hold and its Settings detour. Returning to Admin reuses the same authoring session, draft, and frozen unresolved operation. Normal departure still checks unresolved work and confirms abandonment; actual workspace teardown destroys the owner. Saved-contract selections use their existing membership-scoped draft journal when taking the Settings recovery detour. No visibility change initiates an Admin save.

Deferred Admin and saved-contract navigation captures SvelteKit's intended destination scroll before commit and applies it once the current document is visible and fully prepared. Fragments wait for that DOM as well. New navigation or user input cancels a pending restoration, and focus changes only if it is still on the body. The creation handoff retains `noScroll`/`keepFocus`, and `?review=1` links keep their existing review-specific focus handling.

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

Initial login HTML contains the email form; active invitation HTML contains company context, the invited email, and Continue. The anonymous preview uses a server-only Convex HTTP client. The initial static login and anonymous invitation graphs exclude the Convex transport and workspace document/cache modules. Authenticated invitation resolution code loads only for a signed-in account. During email verification, startup preparation warms an unused Convex connection and preloads the authenticated account host plus the requested route's code. Direct protected workspace loads start those independent downloads while Clerk connects. Workspace destinations also preload the workspace, Home destinations preload Home, and saved-contract destinations preload the document host. Routes requiring a baseline leave editor and renderer loading to Workspace's baseline-readiness guards. Entry destinations avoid those workspace imports. Preloading does not mount components or start authenticated queries; a verified session takes ownership of the warmed connection once.

Ordinary signup preloads and opens onboarding, preserving any requested workspace destination for joining an existing company. After onboarding paints, it preloads the admin setup route without speculatively loading Home. Creating a company opens `/admin`; its completion destination survives temporary blocking of the same session, while navigation waits for readiness. Joining keeps the requested workspace destination. The admin editor and renderer load only after the company's baseline is ready.

Account admission, workspace admission, and the destination's usable marker are distinct. Workspace chrome appears only after membership admission. Home controls do not wait for contract-list results, and document routes load their renderer on demand. Account, workspace, invitation, and deferred workspace component imports share one bounded loader with stale-result protection. Admin code downloads alongside the document host without admitting the editor early. Saved-contract code loads for direct saved routes or when creation is submitted, overlapping the creation mutation and snapshot preparation; a new visit keeps its naming dialog and skeleton in a lightweight shell while creation code loads. Optional preview imports recover through transport replacement and existing creation controls. A session retry clears the account read failure and restarts failed imports through the transport generation. Recovery replaces the transport while retaining admitted editors; logout and leaving a company retain the existing save, cancel, and explicit discard guards.

Invitation preview and resolution run in Convex's default runtime using Web Crypto
for SHA-256; invitation email uses Node for random-token creation, while contract
email uses the default runtime and Loops HTTP. When the server skips anonymous preview,
the route uses the shared account-loading recovery while Clerk initializes, so a
failed initialization exposes the existing retry control.

Document help belongs to `WorkspaceChrome`, alongside its Help buttons. Admin waits
for prepared, visible document content; saved contracts wait for their existing
visible-state reconciliation. Admin Help opens only from its button. Each rep
workspace opening checks the “Don't show this again” preference once, and its Help
button can reopen the guide.
Loading, missing-contract, and failed-opening views cannot mount the guide. During
creation, `ContractRoute` admits the prepared saved workspace only after the naming
dialog completes its opening handoff; background recovery after a failed attempt
does not bypass the retry dialog. The shell has no route-driven help context or
modal hold counter.

Successful contract upload and activation open the delegation modal through a
one-time `/admin` history-state handoff. `WorkspaceShell` owns one bottom-right
lazy `CsmWidget`; the widget owns one captured request and native modal frame.
The profile/calendar body is a separate request-only import. Before the
setup call is booked, only admins on `/admin` see the delegate widget, after the
current primary content's success/error paint and with an active baseline. Closing
leaves the
desktop card or compact mobile launcher; ordinary visits do not open the modal.
After booking, that same widget becomes support on every workspace route for admins
and reps, using an animated filled lifebuoy. There is no header support button.
The modal uses setup or support copy with the same Customer Success
profile and inline Cal.com calendar. A second request cannot replace an open modal;
later uploads consume their handoff without auto-opening support. New optional work
waits for current route/query, local phase/retry and connection identity to settle
and paint; initialized support remains visible during later loading/errors. A
cached module cannot bypass admission, including a never-mounted booking body.
Attribution uses a bounded, cancellable first-result subscription. The official
calendar SDK runs in a disposable same-origin frame, removed on booking completion, close or failure
with all its runtime resources. Only script bytes may be reused via HTTP cache.
Booking uses
Cal.com directly, with a signed company-and-purpose reference in the embed and fallback
link. Only a verified setup webhook sets the company's optional booking timestamp; the
existing live account subscription switches the widget to support across the company.
The embed event also switches it immediately in the booking workspace, without
writing persistence. Support bookings leave setup state unchanged, and support remains
available for repeat calls. A successful embedded booking replaces the calendar with
a focused success message and **Close** button; the user dismisses the modal themselves.
It also collapses the widget to its icon, persisting the collapsed preference and
restoring focus to the icon after dismissal. Booked companies do not reopen setup
after another upload.
See [CSM booking](delegation.md) for activation.
Before booking, leaving `/admin` unmounts delegation and closes setup, including when
the authoring owner remains mounted for Settings recovery. Support remains mounted
across workspace routes. Committed pathname changes and replaced connections close
the shared modal; deletion holds and blocked/closing sessions unmount the widget in
either mode. The former post-upload instructions guide has been removed.
