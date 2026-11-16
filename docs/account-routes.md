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

`AccountSession` owns shared workspace presentation hints for loading. A bounded,
versioned cookie stores membership/company IDs, role, template readiness,
instructions readiness, and optional buyer-link presence. It expires after 24 hours
and is scoped to the Convex deployment, user, and session. The workspace server
layout reads it only after its existing authentication check and returns matching
hints as page data, without a backend query. Initial server rendering and hydration
use the same hints while Clerk connects; the initial seed is retired once Clerk
loads or the session closes and cannot return for a later identity. Unknown,
expired, malformed, or mismatched hints retain the common skeleton. The cookie is
JavaScript-writable and deliberately carries no authority: hints never admit
private content or grant permissions.

Once Clerk identifies the user, any available account result (including matching
server startup assistance) takes precedence. Otherwise the hint owner reads the
cookie and matching session/membership/company-scoped local display fields (names
and avatar URLs, bounded to 16 KiB and 24 hours). Layout facts live only in the
cookie; larger display fields never enter request headers. If no layout hints are
available, one bounded `accounts.workspaceRole` request runs independently of full
account startup, including during sign-in. Retries follow the transport generation.
Confirmed membership updates persistence after rendering and retains buyer-link
presence only for the same membership and company. Membership loss, company
departure, and account deletion remove the current records. Ordinary sign-out
clears active hints and cancels queued writes; the previous session's cookie cannot
seed a new session. Late results cannot cross identities or overwrite confirmed
membership. Storage failure leaves in-memory hints usable.

`WorkspaceSkeleton` consumes these hints at every account/workspace/module loading
boundary. Known unfinished templates use `TemplateSetupLayout`, including the
calendar skeleton for admins; known ready templates use the document placeholder or
the creation dialog with a plain preparation message. Role-specific navigation, Settings, Team, and Integrations skeletons and
the Contracts buyer-link column use the same context. Presentational components
receive props and perform no storage access or fetching. Unknown roles never
default to admin. A stale matching hint can briefly choose an outdated placeholder
until live account data corrects it.

`Contracts` records buyer-link presence from its company-wide live query: any returned row establishes presence, while only an error-free, exhausted empty result establishes absence. Loading, query failures, and empty intermediate pages do not clear the hint. `WorkspaceSkeleton` passes remembered presence into `ContractsSkeleton`; both it and the mounted Contracts page use the matching buyer-link skeleton while presence is known and rows are pending. The sidebar keeps its 450px desktop column and stacks below contracts on smaller screens. Unknown presence uses the common full-width grid, so a first visit without remembered data can still change layout when links arrive. Buyer-link loading never gates the contract list. Skeletons do not fetch or read storage.

`WorkspaceBoundary` requires a live profile, membership, and company. `WorkspaceScope` is keyed by profile and membership and supplies viewer context plus the contract editing sessions that survive route changes. Each workspace captures its own cache instance, cancels its pending reads, and destroys its document resources on teardown; an old workspace cannot cancel a replacement's cache. Membership loss clears the previous membership's draft journal and removes the workspace. Role changes preserve its identity and mounted drafts.

`WorkspaceShell` mounts the shared header and interaction dispatcher as soon as membership is admitted, including while workspace or document code is loading or has failed. Document chrome contributes its search and status content through a scoped header registration. `auth/routes.ts` supplies titles, navigation selection, template source requirements, and document classification to both mounted routes and URL-only preload/performance callers. The root is the only title writer; entry flows can register a title override scoped to the current route. Titles therefore update at navigation commit even when an editor cannot mount, which also gives SvelteKit's navigation announcer the destination title.

`DocumentBody` gates initial body mounting on any required template source and, by default, the lazy document host. The contracts layout opts out of the host gate so its skeletons and naming dialog can mount while document code loads; each editor still waits for the host. The persistent template editor owner mounts outside `DocumentBody`, after both its own module and the host are ready. Once mounted, a company deletion hold hides and disables the body while retaining its state. Document resources remain mounted with preparation paused; contract persistence pauses new saves, and document reads stop. Already dispatched writes keep their existing outcome semantics. Settings stays available to finish or cancel deletion, and the contract naming dialog leaves the browser's modal layer during the hold without clearing its input.

Contracts and Team bodies unmount during a hold, releasing their queries, shortcuts, and modals. Their route metadata and shared navigation remain mounted. The route catalog marks Settings as available during the hold.

The workspace retains an admitted template editor owner through a reversible hold and its Settings detour. Returning to Template reuses the same authoring session, draft, and frozen unresolved operation. Normal departure still checks unresolved work and confirms abandonment; actual workspace teardown destroys the owner. Saved-contract selections use their existing membership-scoped draft journal when taking the Settings recovery detour. No visibility change initiates a template save.

Deferred template editor and saved-contract navigation captures SvelteKit's intended destination scroll before commit and applies it once the current document is visible and fully prepared. Fragments wait for that DOM as well. New navigation or user input cancels a pending restoration, and focus changes only if it is still on the body. The creation handoff retains `noScroll`/`keepFocus`, and `?review=1` links keep their existing review-specific focus handling.

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

Initial login HTML contains the email form. Anonymous invitation HTML contains a public pending frame; its bounded server preview streams company context, the invited email, and Continue after validation. The anonymous preview uses a server-only Convex HTTP client. The initial static login and anonymous invitation graphs exclude the Convex transport and workspace document/cache modules. Authenticated invitation resolution code loads only for a signed-in account. During email verification, startup preparation warms an unused Convex connection and preloads the authenticated account host plus the requested route's code. Direct protected workspace loads start those independent downloads while Clerk connects. Workspace destinations also preload the workspace, Contracts destinations preload Contracts, and saved-contract destinations preload the document host. Routes requiring a template source leave editor and renderer loading to Workspace's template source-readiness guards. Entry destinations avoid those workspace imports. Preloading does not mount components or start authenticated queries; a verified session takes ownership of the warmed connection once.

Ordinary signup preloads and opens onboarding, preserving any requested workspace destination for joining an existing company. After onboarding paints, it preloads the template setup route without speculatively loading Contracts. Creating a company opens `/template`; its completion destination survives temporary blocking of the same session, while navigation waits for readiness. Joining keeps the requested workspace destination. The template editor and renderer load only after the company's template source is ready.

Account admission, workspace admission, and destination readiness are distinct. AccountSession keeps the public route children in one position and runs AuthenticatedAccount as a sibling driver. AccountContentScope installs its shared client only for admitted content; RepWorkspace reads the one application backend-auth publisher. WorkspaceFrame persists around initial skeletons and admitted workspace content. A delivered viewer rejection hides private display while retaining save owners; a confirmed identity/membership/company replacement tears down the old scope. Workspace chrome appears only after membership admission. Contracts controls do not wait for contract-list results, and document routes load their renderer on demand. Account, workspace, invitation, and deferred workspace component imports share one bounded loader with stale-result protection. Template editor code downloads alongside the document host without admitting the editor early. Saved-contract code loads for direct saved routes or when creation is submitted, overlapping the creation mutation and snapshot preparation; a new visit keeps its creation dialog in a lightweight shell while creation code loads. Optional preview imports, reads, and rendering recover through local retry controls. A session retry clears the account read failure and restarts failed imports through the transport generation. Recovery replaces the transport while retaining admitted editors; logout and leaving a company retain the existing save, cancel, and explicit discard guards.

Invitation preview and resolution run in Convex's default runtime using Web Crypto
for SHA-256; invitation email uses Node for random-token creation, while contract
email uses the default runtime and Loops HTTP. When the server skips anonymous preview,
the route uses the shared account-loading recovery while Clerk initializes, so a
failed initialization exposes the existing retry control.

Document Help uses a shared session owned by `RepWorkspace` or the buyer-link
`BuyerContract`, so renderer, version, and preview changes retain the opening
decision. Rep and normal seller buyer-link views automatically open Help once per
opening unless hidden; the two independent preferences live on the authenticated
profile and follow the account across links, browsers, and devices. Actual buyers
use a fresh browser-local `dinu:help:anonymous-buyer-link:<token hash>` key for each
link. Templates and seller View as buyer preview only open Help from the rail and
have no preference checkbox. Entering preview closes Help and consumes its automatic
opening decision; returning to seller view does not reopen it. Manual Help is
available as soon as the document is ready, even if preference readiness is still
pending, and consumes any pending automatic decision. Checkbox changes wait for
persistence, retain the confirmed value on failure, and expose an inline retryable
error. Seller writes use the authenticated account transport; public buyer reads
remain anonymous.
Loading, missing-contract, and failed-opening views cannot mount the guide. During
creation, `ContractRoute` admits the prepared saved workspace only after the naming
dialog completes its opening handoff; background recovery after a failed attempt
does not bypass the retry dialog. The shell has no route-driven help context or
modal hold counter.

Successful template upload and activation open the delegation modal through a
one-time `/template` history-state handoff. `WorkspaceShell` owns one bottom-right
lazy `CsmWidget`; the widget owns one captured request and native modal frame.
The profile/calendar body is a separate request-only import. Before the
setup call is booked, only admins on `/template` see the delegate widget, after the
current primary content's success/error paint and with an active template source. Closing
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
Before booking, leaving `/template` unmounts delegation and closes setup, including when
the authoring owner remains mounted for Settings recovery. Support remains mounted
across workspace routes. Committed pathname changes and replaced connections close
the shared modal; deletion holds and blocked/closing sessions unmount the widget in
either mode. The former post-upload instructions guide has been removed.

## Public buyer routes

`/[token=buyerCode]` displays the contract's current approved document directly, beneath the
buyer header at the existing navigation height. Codes are 13 case-sensitive ASCII
base62 characters with about 77.4 bits of entropy. The canonical URL is `/<code>`;
old buyer route aliases are removed. The route lives in the shared `(buyer)` layout.
These routes bypass full account/workspace initialization and own an anonymous
Convex client for the approved document. Existing dashboard sessions are recognised
separately: a session-cookie hint may load the existing Clerk session, then a private
Convex transport subscribes to the token-scoped `buyerLinks.sellerContext`. Only a
verified member of the contract's company gets seller controls. Missing profiles,
unrelated-company accounts and signed-out visitors get the buyer presentation.
There is no sign-in flow on the link; sellers sign in through the dashboard.
Responses use no-store, no-referrer and noindex.
There is no buyer form, autosave, readiness submission, or dirty-departure prompt.

The dashboard contract workspace contains private rep instructions, concessions and
admin approvals. Shared buyer guidance, comments and proposals live on the buyer link.
The dashboard's **Open buyer collaboration** action prepares the same permanent URL
as copying, preserving saved-state/deal gates without emitting copy feedback.
Seller view adds an avatar linking to the dashboard, a blue underlined
**View as buyer** button, proposal handling and the shared support widget.
Buyer preview hides the avatar and shows muted **You are in buyer view.** text with a
blue underlined **Back to your view** button, matching the company setup prompts.
It uses the same
buyer document and public discussions below it in read-only mode. Stored author
names replace the seller-relative “You”; authoring, account recovery, private
proposal facts and seller actions are hidden. Unsent drafts remain private and
pending submissions retain their original author, payload and operation ID. Mode
transitions prevent delayed auth/bootstrap/write work from dispatching in preview
or becoming valid again after a quick return. Already-dispatched requests settle
without reopening editors or moving preview focus. Public reading, pagination,
navigation and downloads remain available. The header's return button restores
seller view, and seller visits remain excluded from buyer analytics.
Actual buyers see the original header/layout and no support widget.
Seller-only reads expose native proposal support, current/applied changes and exact
review eligibility. These facts never enter public discussion responses and clear
on preview or access loss.

Supporting a shared proposal creates a native buyer-link change. Permitted work
applies immediately; restricted work waits for admin approval while the current
approved wording remains visible. Source and decision expectations fence stale work;
see [contract change reviews](lifecycle.md#contract-change-reviews) for support,
approval and source-independent applied undo. Permanent URLs remain stable.
New proposal work receives the existing fresh HubSpot check. Cancelling before
dispatch retires that captured action; uncertain dispatched writes retain their exact
revisions and operation ID for receipt-first retries. Discussion viewer requests also
belong to an account epoch: a superseded cookie-setting request settles under its
original lock, while the new account waits for its own viewer result. Drafts and
original-author recovery identities survive the transition.

Each contract has one permanent buyer link. Document blocks are acquired once per
opening; its live approved-view pointer updates the title, buyer name and document
identity while the contract is attached. See the
[buyer-link model](data-model.md#buyer-links-and-shared-discussions). Pending acquisition is canceled on
exit. Public status is `current` or `unavailable`; losing access discards the document,
and recovering access reacquires it. Seller activity refreshes while its panel is open.

Public content and Word downloads independently check access. Downloads also require
connection and recheck the displayed document identity so an outdated document cannot
be released after approved wording changes. Activity delivery is independent of document
access. A separate cookie preserves anonymous discussion ownership. Retired form data has a bounded
[cleanup procedure](buyer-form-removal.md).

The route catalog explicitly classifies loading presentations, including integration details and buyer destinations. Region subscriptions retain accepted data only for the same arguments, fence obsolete callbacks and expose local deadlines/retry. HubSpotDeals owns coalesced request deadlines so Retry can replace a hung shared request. Buyer AnonymousProvider lives in the buyer layout; compatible document opening retries preserve the accepted resource and scheduler. Basic public/Contracts graphs exclude document construction, profiling and authoring-controller implementations; `verify:loading-bundles` checks emitted source-module closures after build.

## Contract-card link activity

The anchored panel beside Copy link shows recorded openings and distinct-clause
activity from the newest ten eligible visits, with five measured rows before
scrolling. It uses an authorized trusted-clock mutation while open, refreshes every
30 seconds and removes expired rows locally. No city or account tags are collected.
Visitor numbers are contract-local approximate browsers, not people.
Page openings from the same browser share a visit until 30 minutes without
meaningful activity. Refreshes and extra tabs within that window add no opening
row. Scrolling, direct interaction and clause clicks update the inactivity clock;
background polling and visibility changes do not. Only a new page opening after
the gap records a return; inactivity never invents an opening. Outside click,
focus leaving and Escape retain existing dismissal and focus behavior.

Buyer activity records openings and clause clicks automatically. Browser recognition
is contract-scoped; event history stays on the server. Reading, downloads and
discussions are independent of activity delivery. See [activity storage](cookies-and-activity.md).

## Contracts routes

`/contracts` is the contracts list and the default workspace destination. `/` redirects to it, preserving query parameters. Login and onboarding normalize old root return destinations to `/contracts` while retaining requested contract URLs.

The list owns its streamed startup loader and lazy Contracts module. New and saved contracts share the persistent `contracts/(document)` layout, preserving the naming-dialog handoff to the saved workspace. Contract settings sits outside that layout and needs no editor-bypass condition. The route catalog uses URL patterns and strips layout groups from mounted route IDs, so layout organization does not change navigation policy. The existing `accounts.startupHome` backend query and startup snapshot data contract remain in use.
