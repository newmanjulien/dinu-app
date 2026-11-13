# Unread buyer comment pill

Status: implemented and deployed to development; static checks, production build and existing performance checks passed. Browser/multi-user acceptance remains manual.
Prepared directly from the code and screenshot; plan-refine was not used.

## Outcome

Each Buyer links row can show a compact, outlined, rounded pill with a green dot
and the exact text **Unread comment**. Place it beside the buyer name, before the
existing activity button. Keep the row's current padding and normal text styling.
Allow wrapping on narrow screens so the name, pill, and activity control fit.
The pill is a status, not a separate action. Opening the link retains its existing
new-tab behavior; the activity button remains independent.

The state belongs to the company: once any authorized, signed-in company teammate
sees a particular buyer message, that message is read for everyone. The pill
remains while any buyer comment, reply, or proposed change on that contract is
unread. Its wording stays **Unread comment** for all three.

## Confirmed behavior and proposed edge rules

The user confirmed both choices:

1. Clear only when a signed-in teammate actually sees the message on screen.
2. Include buyer comments, replies, and proposed changes.

Additional proposed rules: a buyer edit makes the revised message unread again;
deleting a message removes its unread status. Seller-authored messages never
trigger the pill. A signed-in teammate also counts when reading in View as buyer:
read acknowledgments are independent of content-editing permission. Preserve all
existing preview restrictions on composing, editing, deleting, and applying
proposals. Anonymous visitors and users from another company never count.

## What the current code establishes

- `discussionService.writeDiscussion` is the sole message insert/edit/delete path
  and already makes retries idempotent through operation receipts.
- `discussionActor` derives company teammates from authenticated membership.
  Buyer actors have no `profileId`; client-supplied author labels are not authority.
- Before this change there was no message read-state storage.
- `DiscussionThread` renders roots and replies through `DiscussionMessage`.
  Replies are paginated, and narrow-screen threads can be loaded but CSS-hidden.
- `DiscussionLayer` has explicit active/obscured state. DOM mounting and successful
  feed reads therefore cannot serve as evidence of visibility.
- Public discussion subscriptions use the public client. `BuyerSeller` already
  owns the separate authenticated client, membership, account identity, and
  lifecycle handling needed for private acknowledgments.
- `buyerLinks.browse` is authenticated, company scoped, paginated, and already
  returns each link's contract ID.
- Contract/company cleanup already deletes discussion message rows.

## Implementation sequence

1. **Store one shared state on each message.** Add a required
   `unreadByTeam: boolean` to `storedMessage` and an index over
   `contractId, unreadByTeam`. Initialize it on every message insert. Set it
   true only for buyer-authored messages, using the server actor; every discussion
   type qualifies. Set it true on buyer edits and false on deletion,
   atomically with the existing message write. Leave operation-replay returns
   ahead of these updates so replaying a write cannot resurrect an unread flag.
   No per-user read records, contract counters, notification queue, or new table.

2. **Add a bounded, authenticated acknowledgment mutation.** Accept membership ID,
   contract ID, and at most 20 `{messageId, revision}` pairs. Derive the caller
   through `requireMembership`; verify the live contract and every message belong
   to that company/contract. Clear only qualifying, undeleted messages whose
   current revision exactly matches the submitted revision. Already-read,
   deleted, missing, or superseded messages need no update. Reject foreign
   message ownership. Repeated or simultaneous acknowledgments are harmless;
   they need no extra operation-receipt mechanism. Never accept a caller-supplied
   reader identity or treat possession of a buyer URL as read authority.

3. **Acknowledge visible messages through the private client.** Observe the
   rendered comment text in `DiscussionMessage`, covering roots and replies.
   Require a readable portion to be on screen continuously for about 500ms,
   document visibility/focus, an active and unobscured discussion layer, accepted
   feed access, and the authenticated teammate context. Do not require the whole
   message to fit in the viewport, because long comments must still be readable.
   CSS-hidden mobile threads, unloaded replies, inactive retained documents,
   and background tabs do not count. Derive reader eligibility from the signed-in
   company context rather than the session's content-editing/read-only policy.
   Recheck eligibility and the
   exact revision before dispatch. Pass observed pairs through the discussion
   session to `BuyerSeller`'s authenticated client; do not mutate through the
   public discussion connection. Coalesce small batches and deduplicate in-flight
   or successful pairs for the current account/session. Reset pending work on
   account, contract, access, or lifecycle changes. A failed read
   acknowledgment leaves the server flag untouched and can retry when the
   eligible view/connection recovers. No optimistic clearing or browser storage.

4. **Expose a cheap reactive flag on each link row.** In `buyerLinks.browse`,
   query the new index for that contract with `unreadByTeam === true` and
   take at most one result. Return `hasUnreadComment: boolean`. The listing never
   scans all discussions or maintains a second count. Native Convex reactivity
   updates all company viewers when a comment arrives, changes, is deleted, or
   is acknowledged. Keep this private state out of public discussion DTOs.

5. **Render the screenshot-style pill.** Use inline Tailwind classes on the
   existing BuyerLinks row: thin neutral border, rounded-full shape, surface
   background, small green dot, compact regular text. Keep the dot decorative
   and expose the words to assistive technology. Render only when the server
   flag is true; keep the existing recent-activity control and link destination.

6. **Validate and deploy the complete change.** Run Svelte/tool checks, Convex
   TypeScript checking, and targeted formatting/whitespace checks. Review both
   authorization paths and all message lifecycle transitions. Update relevant
   architecture documentation. Do not add tests or browser automation under the
   repository instructions. Announce the verified deployment target before
   pushing. Confirm the new query return shape and mutation are deployed together
   with the schema before asking the user to check the UI.

## Concurrency and acceptance cases

- Buyer posts a comment: the pill appears for every teammate in the company.
- A teammate opens the link without seeing that comment: it remains unread.
- A teammate sees one of several unread messages: only that message clears.
- A buyer posts a new message while another is acknowledged: the new one remains.
- A buyer edits during acknowledgment: an acknowledgment of the old revision
  cannot clear the new wording. Deleting the last unread message hides the pill.
- Two teammates acknowledge the same message: the result remains correct.
- Buyer visitors, another company, hidden threads, and background tabs cannot
  clear it. A teammate seeing a message in View as buyer does count, with content
  editing still disabled. Identity changes cannot dispatch queued reads as a new
  user.
- Reload/navigation retains state through Convex; there is no local unread cache.
- Existing copy confirmation, recent activity, link pagination, and contract
  saving/publication remain intact.

These are acceptance scenarios, not claims that existing automated tests cover
them. Browser and multi-account behavior remain unverified until exercised.

## Data and rollout

Honor the requested clean schema: no legacy read-state interpretation, optional
compatibility field, migration runner, or backfill. Existing messages have no
historical evidence of being seen, so do not invent read timestamps. The required
field means a deployment with existing message rows needs a clean reset before
the schema can validate. The user has allowed a database wipe; identify the exact
target and use the project's reset procedure when implementing. Production changes require their own explicit
target-specific authorization.

Existing message cleanup owns the new field automatically; no additional cleanup
table or background job is required.

## Implementation progress (2026-11-11)

- Required `unreadByTeam` state and contract/unread index added; buyer creates,
  replies, edits, deletes and replay ordering handled in the sole write path.
- Authenticated `discussions.markSeen` validates company/contract ownership,
  batch size (20), positive integer revisions, and exact current revisions.
- Private BuyerSeller transport connected to per-session batching. Pending work
  invalidates with reader identity/access/lifecycle. Successful revisions are
  remembered only within the open session; failure never clears server state.
- Text visibility requires 500ms, focused/visible tab, accepted feeds, active and
  unobscured layer, clipping/overlay hit tests, and a final visibility check at
  dispatch. Roots and replies use the same observer; preview keeps read receipts
  independent of content-editing policy.
- Buyer links query returns a reactive indexed existence flag; link rows render
  the green-dot outlined pill with accessible text and wrapping.
- `npm run check` passed with zero Svelte errors/warnings; tool and Convex
  TypeScript checks passed. All 39 existing performance checks passed. No new
  tests or browser checks.
- Confirmed development target: `disciplined-squid-496`; `.env.local` and public
  URL agree, no shell deployment/deploy-key override.
- Recovery export with file storage saved and ZIP integrity checked at
  `/tmp/oceans-unread-sFgpQS/before-reset.zip`. No pending/in-progress application
  jobs found among the latest 100 root scheduled jobs. Authorized development
  `--replace-all` reset completed; all application/component data was cleared.
  Existing contracts/links/comments and company setup must be recreated. Clerk
  accounts were retained. No business records were restored from old data.
- `npx convex dev --once --typecheck enable --tail-logs disable` completed against
  `disciplined-squid-496` at 12:12:19 local time. Read-only function metadata
  confirms `discussions.markSeen` and `buyerLinks.browse` with
  `hasUnreadComment` are deployed. Production was not changed.
- First full build hit concurrent account-UI changes referencing the removed
  `workspace-role.svelte` module. Those references were updated by the ongoing
  account work; the full production build rerun passed with zero Svelte
  errors/warnings and successful Vercel adapter output. Unrelated edits retained.
- Targeted Prettier and whitespace checks passed for affected source files.
- Concurrent card/query work renamed the displayed label from buyer company to
  contract `title` after the successful first backend push.
  Follow-up pushes encountered incomplete legacy API removals in the shared
  workspace. Removed one dangling `profiles.ts` re-export of deleted
  `legacyAccounts` (no callers); next push found `legacyTemplates` still importing
  removed `legacySnapshot`. Removed the unused `legacyTemplates` endpoint and
  `templates.version` re-export after confirming no callers in source/scripts/tests;
  no compatibility implementation restored.
- Final development push succeeded at 12:18:26 local time. Live metadata confirms
  the query now returns both `title` and `hasUnreadComment`, and `markSeen` is
  deployed. Backend typechecking passed during deployment. Final Svelte check
  again reports zero errors/warnings after generated API changes.
- Remaining runtime acceptance: actual browser visibility/focus/mobile clipping,
  appearance, multi-user races/auth rejection and reconnect behavior. Static
  checks and existing performance tests do not prove those scenarios.


## Deep-audit remediation (2026-11-11)

Scope: implement the two verified findings from
`/var/folders/6w/_vvn6r6d6hbc9vrdf9ds6dsr0000gn/T/oceans-unread-audit-ovnr9ltd/plan.md`.
Preserve all current UI, company/revision/auth/lifecycle/preview safeguards, and
copy feedback. No new tests, browser automation, database reset or deployment.

- Q-01 / R-01 (implemented): use current non-whitespace DOM text fragments,
  clipped and hit-tested, for both the 500ms dwell and final dispatch check.
  Blank lines and unused paragraph width must not count as reading.
- S-01 / R-02 (implemented): remove only the unused optional stored timestamp;
  retain public `createdAt` from `_creationTime` and existing reply ordering.
- Current source matches the relevant audited mechanisms; unrelated shared
  workspace changes are preserved.
- Backend TypeScript passed with `--noEmit --incremental false`. Targeted
  Prettier and whitespace checks passed; focused review confirms public time,
  reply ordering, batching and dispatch predicate reuse are preserved.
- Full production build passed, including Svelte check (zero errors/warnings),
  tools TypeScript, client/server bundles and Vercel adapter output.
  No saving/scheduling/caching changes; no tests added or run.
- Both audit remediations are complete locally. No deployment or database
  changes were performed; the stored-validator cleanup has not been pushed.
- Browser geometry, actual multi-user races and live schema/data compatibility
  remain manual/unverified. Saving, scheduling and caching are outside this fix.
