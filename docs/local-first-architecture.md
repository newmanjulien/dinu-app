# Browser and backend data ownership

Convex owns mutable workspace state. Fast navigation comes from retained live queries, synchronous SDK cache hydration, authorized SSR seeds, and shared immutable content. IndexedDB holds reusable content, while tab-local journals preserve unsaved intent.

## Read ownership

| State                                  | Owner                                | Browser lifetime                                                 |
| -------------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| Viewer and access                      | `accounts.viewer`                    | Authenticated transport; private content waits for accepted auth |
| Help and support choices               | `accounts.uiPreferences`             | Separate live preference query with optimistic writes            |
| Home cards                             | `contracts.home`                     | Always live within the workspace                                 |
| Team and invitations                   | Workspace lists                      | Lazy, retained after first use; native colleague pagination      |
| Saved contract metadata                | `contracts.state`                    | Active editor plus four-entry visited-contract subscription LRU  |
| Template authoring structure and setup | Workspace template reads             | Lazy, retained for the workspace                                 |
| Source prose and item bodies           | Immutable fingerprint/revision reads | Cancellable one-shot reads with bounded memory and disk reuse    |
| Buyer header and applied state         | `buyerLinks.currentState`            | One shared live public-link query                                |
| Discussions                            | `discussions.list`                   | One bounded live contract snapshot                               |

Workspace read arguments omit membership IDs. Each query derives the current membership from authenticated identity; mutations retain expected membership IDs to fence writes after workspace replacement. Stable read arguments let startup registration and mounted consumers share SDK query keys.

Read adapters check `getCurrentValue()` before waiting for the next update. This permits an immediate warm open while preserving live access withdrawal. Cached content, presentation hints, and SSR state never independently authorize a write.

## Opening and navigation

Home SSR streams one `accounts.homeBootstrap` response containing viewer, cards, and setup progress. Saved-contract hard loads use `contracts.routeBootstrap` for the title, initial live metadata, and immutable version identity. The document seed is accepted only for the matching user, session, and transport generation.

Convex clients use `expectAuth: true`. Startup registers viewer and the current route's primary reads before authentication settles: Home, saved state plus its SSR version, template structure, or native Team pagination. This permits the SDK to send authentication and stable query registrations together. Private content remains gated on accepted authentication. Actual deployed WebSocket round trips remain a manual acceptance check.

Cards carry `templateVersionId`, so document loading starts alongside metadata rather than waiting for it. Demand warming batches contract metadata, shares frozen-template requests, prioritizes visible/hovered/unread results, and backs off after failures. Home has no speculative per-card read loop while idle. Rename and removal update the SDK's Home/state cache optimistically; removal clears recovery journals only after the mutation commits.

Buyer SSR supplies the header, refresh eligibility, and signed-in seller classification. The buyer shell and document share current state and start frozen-template loading in parallel. The existing calm header-first reveal remains. Only refreshable linked contracts request the rate-limited provider refresh.

## Immutable storage and memory bounds

| Store                       | Identity                                  | Bound                                                   |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| Contract snapshots          | `templateVersionId`                       | 24 versions / 32 MiB; IndexedDB schema 18               |
| Authoring source prose      | Source fingerprint                        | 16 MiB; seven-day read age                              |
| Authoring item bodies       | Item ID, exact content revision, audience | Eight disk entries / 4 MiB; seven-day read age          |
| Authoring detail preloading | Exact revision                            | 64 memory records / 4 MiB; selected detail has priority |

Contract storage uses deployment/profile/membership namespace `dinu:v9`; authoring storage uses deployment/profile/membership/company namespace `dinu:workspace-read:v2`, schema 8. The latter contains only source and detail stores. Both record their owning user. Shared version/source identities coalesce requests across consumers. Immutable payload budgets total 52 MiB before metadata and native storage overhead; pinned active memory resources may exceed their eviction target.

Mutable contract metadata, Home/Team pages, authoring structure, and save watermarks are never persisted in these databases. Contract saves do not rewrite frozen templates. Authoring saves adopt their acknowledged revision directly and invalidate only affected revision demand. `playbookItems.batchContent` bounds and combines detail hydration; selected items start first and abandoned demand cancels queued work.

IndexedDB and Web Locks are optional. Opens and lock acquisition have deadlines, failed opens can retry, and storage failure leaves memory/live reads usable. Scoped registry retirement handles old databases without adding storage reads to normal document rendering. Logout, identity replacement, confirmed departure, and deletion retire captured owners; ordinary navigation or transient same-session failure retains useful content and intent. Physical native multi-tab cleanup remains a manual check.

## Hints, recovery, and writes

Workspace cookies (version 1, 3,000 encoded characters, 24 hours) and presentation localStorage (version 3, 16 KiB, 24 hours) supply placeholders only. They are fenced by deployment, user, session, membership, and company as applicable.

The separate `dinu:drafts:v7` sessionStorage journal uses envelope version 1 and is scoped to deployment/user/membership/contract. It keeps unsaved selections, the immutable submitted operation, and conflict recovery. Disposable cache eviction does not erase journals. Accepted saves, explicit discard, and confirmed ownership retirement clear the relevant intent.

Writes use backend authority, optimistic state revisions, and exact operation receipts. Unchanged selections and exact replay perform no writes. Authoring uses in-memory save watermarks and preallocated mutable revisions; frozen historical revisions remain immutable. Preferences have independent side-table subscriptions, so toggles do not invalidate the viewer/access query.

## Bounded backend work

Discussion snapshots fetch the newest 200 threads and 2,000 messages and resolve authors once per contract. Create/reply admission enforces the same ceilings. A contract-scoped `discussionCapacity` row tracks stored rows and bytes, enforcing a 4 MiB discussion document budget on creation and edits. Messages awaiting asynchronous thread cleanup retain capacity until deletion; contract/company erasure removes the counter. Older replies reveal locally; no scroll-driven reply query is required. Acknowledgement reads and patches are batched.

Due-row writes schedule their retry or lease watchdog at the stored timestamp. Jobs check current timestamps, ownership, generations, or leases before doing work. One ten-minute indexed `recovery.sweep` discovers missed CSM/HubSpot jobs and schedules only nonempty worker families. Delivery and quote pumps share a 20-row budget across statuses; quote expiry shares 25 rows across payload and diagnostic cleanup. Each native page runs in an internal query, respecting Convex's single-paginated-query execution limit. Continuations are scheduled only when more work or a future active lease remains.

Quota-owner expiry runs daily. Journal's five-minute probe starts provider polling only when enabled and a HubSpot connection exists. Other retention and deletion jobs keep their bounded independent schedules; the sweep does not replace their ownership protocols.

See [data model](data-model.md), [automated guarantees and manual limits](performance-checks.md), and [deployment](deployment.md). The strict model requires a fresh database; local implementation performs no reset or deployment.
