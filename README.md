# Dinu

A SvelteKit / Svelte 5 contract workspace backed by Convex.

For production configuration and the coordinated Vercel/Convex release process,
see [Production releases](docs/deployment.md).

The immutable contract source is separate from the Playbook. A Playbook Item has
one or more Triggers, optional instructions, and negotiation concessions. Each
concession applies an atomic set of source-coordinate Contract Changes.

`/` owns a `RepWorkspace` and `RepPlaybookPanel`. `/admin` owns an `AdminWorkspace`
and `PlaybookEditor`. Both share the document viewer, chrome and rendering
machinery. The viewer receives only the derived document overlay, not instructions,
draft state or save operations.

Admins select unowned source to create an item or click a Trigger to edit its
complete item. One local draft supports instructions, multiple Triggers, preferred
and rare concessions, multiple changes, and structured contract references.
Save validates and submits the complete instruction box; Cancel discards local
changes without writing. Adding a concession to an existing box updates only the
parent draft until that box is saved. Back preserves entered clause selections and
wording. Their concessions
are read-only, including newly added concessions in the draft. Changing a concession
requires deleting it and adding a new one.

An unchanged existing instruction box can be replaced by another box or by an action
on selected text. Highlighting alone keeps its editor open. Unsaved changes block
replacement with a red warning while preserving the selection. New creation still
requires finishing or explicit cancellation.

Typing, outside clicks, Escape and tab visibility never save. Dirty drafts stay
open until Save, Cancel or confirmed abandonment during navigation. An unresolved
operation blocks editing and internal navigation; Retry sends the same immutable
operation. Rejections keep the draft editable, conflicts offer Use saved version,
and remote deletion is reported explicitly. Save/delete acknowledgments close the
editor and briefly show completion feedback. Delete requires confirmation. Local
drafts are not restored after refresh; browser unload warns while work remains.

Reps can apply one concession per item. Cross-item conflicts are explained and
blocked. Choices are workspace-local and reconcile against live item identities.
The renderer preserves source coordinates and stable prepared tokens, compiles
whole-block browser geometry into cached layout profiles, paginates the complete
document and reconciles unchanged pages before committing one current snapshot.
Saved alternatives can prewarm the normal geometry cache during idle time.
The layout shares pure compiled source and indexed Playbook geometry across routes;
item-aware ingestion keeps metadata-only updates out of rendering. Search discovers
matches from committed page tokens, and annotation owners register by membership.
Search refreshes from snapshot commit IDs. Save, render and
source status remain independently visible above document flow.

## Development

Node.js 22.12 or newer is required.

```sh
npm ci
npm run seed:verify
npx convex dev
```

Configure `PUBLIC_CONVEX_URL` and the Clerk development keys in `.env.local`.
For a fresh development deployment, run `npm run dev`, sign up, and create a
company. Copy its ID from the Convex dashboard, then run
`npm run convex:seed -- --company-id COMPANY_ID`. Each company starts without a
template; contract creation becomes available after its initial scoped import.
Follow [Clerk setup and rollout](docs/clerk-auth.md) before starting `convex dev`:
the backend needs the matching JWT issuer. Local verification and production builds
can run before Clerk is configured; the app shows a setup screen until keys exist.
The canonical bootstrap data is `data/convex`: 113 immutable blocks and
56 Playbook Items, containing 62 Triggers, 26 concessions and 66 changes.
The seed command refuses to overwrite edited runtime records and resumes an
interrupted items-first import. It only loads initial company templates.

This schema requires canonical baseline/revision links, creators, review maps, and
numbering/reference patterns. Clear incompatible database data before deployment,
then create the company through normal onboarding and reseed it. Follow [the fresh reset runbook](docs/private-companies-rollout.md#fresh-development-reset).

## Server and browser responsibilities

DOCX import and Word generation run in Convex Node actions. Word download generates
one file on demand from an authorized saved revision, checks required approvals,
and rechecks access, revision, and approvals before returning a temporary download URL. Files
expire after one hour. Opening a contract or editing selections does not generate
Word files.

Live contract reads contain compact metadata and a template version ID. The current
template query returns only its version ID. One membership-scoped browser loader
shares immutable template reads by version across previews, creation, opening, and
prewarming, including versions already in IndexedDB. Contract opens still confirm
live membership and saved state before showing cached content. SvelteKit guards
routes; authenticated browser reads go directly to Convex.

Composition, pagination, selection, highlights, document search, and unsaved draft
recovery remain in the browser. Approval and export readiness depend on saved state,
independently of viewer layout. The backend enforces permissions, saved revisions,
concession validity, and review decisions.

## Approval request email (preliminary)

Explicit Approve/Reject decisions send the contract creator a plain-text summary
as soon as every applied concession requiring approval has been decided. Approved
and rejected outcomes both count as reviewed; concessions that do not require
approval do not block the notification. There is no batching delay. A changed
decision after completion sends an updated summary, while no-op decisions and
operation retries do not send another email. Automatic approvals during admin
saves do not trigger notifications.

Decision summaries use the same Gmail credentials and `APP_URL` as approval
requests. The creator receives the email at their current profile address, with
the final reviewers CC'd once each. Recipients must still belong to the contract's
company. A separate review generation identifies each completion event, so an
approve/reject/approve sequence cannot revive an older approved summary. Saving
choices advances this generation without sending a summary; explicit changed
decisions advance it and queue immediately when review is complete.

Approval requests, decision summaries, and invitations share `emailDeliveries`
and the same dispatch, completion, logging, recovery, and cancellation code.
Snapshots live in byte-bounded `emailSnapshots` chunks. Current reviewer attribution
lives in bounded `reviewAttributions` chunks and is maintained with review state;
summary preparation never reconstructs it from audit history. Both contract email
kinds load descriptions by concession ID, in batches of 16 with four concurrent
queries. Creator availability is checked before preparation, and eligibility and
live recipients are checked again atomically when claiming dispatch.

Decision summaries automatically retry known safe failures up to three total
attempts. Each retry keeps the same event and snapshot, with a new attempt guard.
Uncertain SMTP outcomes and partial recipient acceptance are retained without
automatic resend; an accepted CC never counts as notifying the creator. After
fixing configuration, a failed current decision summary can be explicitly retried
through internal `emailDeliveries:retry` with its delivery ID. That function
refuses uncertain, partial, stale, or actively running deliveries. Contract/company
deletion cleans up snapshots and attribution and cancels tracked jobs.

An applied concession requires approval when its instruction box's “Changes need
to be approved” field contains nonblank text in the saved contract's playbook
snapshot. Pending or rejected concessions block Word download. Approving them or removing
them restores normal download eligibility. “Ask for approval” is available once the contract is
saved, connected, and free of errors or conflicts.

Requests capture the saved company name and every applied concession's description,
mark the concessions requiring approval, and omit approval-guidance text. The email
subject is `Approval requested — <company name>'s contract` and its single workspace link is
`APP_URL/contracts/<contract ID>?review=1`. One latest request per contract lives in the
`approvalRequests` table, separate from saving state and revisions. Requests capture
the company name, canonical recipient, and immutable concession references in
`emailSnapshots`. Their public status is derived from the linked delivery record.
An unchanged pending application set is deduplicated only for the same recipient;
changing the configured address permits a new request. Retrying a failed unchanged
request reuses its event and snapshot. Contracts without previous requests need no backfill.

Configure these **Convex backend environment variables** on the intended deployment
with `npx convex env set NAME value` (not as public SvelteKit environment variables):

| Variable            | Value                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SMTP_USER`         | `julien.newman@gmail.com`                                                                                        |
| `SMTP_APP_PASSWORD` | Gmail app password for that account; setup deferred                                                              |
| `APP_URL`           | Production website origin from the [release runbook](docs/deployment.md); `http://localhost:5173` in development |

Set each company’s approval recipient in Settings. Requests capture that recipient
when queued. Invitations also use these SMTP credentials and `APP_URL`.
Nodemailer uses `smtp.gmail.com:465` with TLS and sends as
`Dinu <julien.newman@gmail.com>`. Missing variables are listed in the request's
failure feedback. A durable marker records dispatch immediately before
SMTP. Recovery checks the scheduled action every minute and blocks all further
requests while that job is pending or running. A stopped job with no dispatch is a
confirmed failure. DNS failure (`EDNS`), message preparation failures (`EMESSAGE`
at `API` or `MAIL FROM`), explicit SMTP rejection, and authentication failures are
also confirmed failures; explicit retry is available as soon as the original job
ends.

An ambiguous failure after dispatch, including Gmail acceptance whose status could
not be persisted, a malformed final `DATA` reply without explicit rejection, or a
generic connection failure, is uncertain. All requests for that contract are
blocked for 10 minutes after uncertainty is detected. A scheduled mutation enables explicit
retry after the cooldown and original job completion. Dispatch and recovery job
IDs are tracked and canceled on completion, replacement, and deletion. Completion
writes explicitly clear obsolete outcome fields. Result persistence gets three
attempts without repeating SMTP. Successful requests cover the same pending
applications at the same canonical recipient. Each completion and recovery matches
the delivery ID and attempt so old workers cannot overwrite a newer attempt.
An email already dispatched cannot be recalled.

All senders accept one canonical plain mailbox and pass structured addresses to
Nodemailer. Configuration is trimmed and requires an HTTP(S) app origin without
credentials, a path, query, or fragment. Delivery logs contain delivery ID, attempt,
stage, allowlisted error codes and SMTP commands, and numeric response code.
Credentials, email bodies, raw responses, and raw transport messages are excluded.

Invitation batches retain their five-worker pool, inline recipient results, and
four-minute socket cancellation. The two-minute resend cooldown is separate from
delivery recovery: an unresolved inline attempt blocks replacement until beyond
Node's ten-minute action limit. The shared completion path persists acceptance
with safe retries and cancels the recovery job. Invitation expiry jobs are tracked
and canceled when replacing, accepting, revoking, or deleting the invitation.

After deploying this refactor to an existing deployment, run internal
`emailMigration:upgrade` on that same deployment. It is idempotent, archives legacy
notification outcomes without resending mail, moves approval snapshots into
bounded chunks, backfills current reviewer attribution, adopts existing
invitation expiry jobs, and cancels obsolete email callbacks. The legacy notification table and approval validator remain
readable solely for this upgrade; new writes use the shared delivery core.
Live SMTP delivery still requires manual verification.

Sending an email keeps download blocked until every required concession is approved.
Approval decisions are scoped to the saved application lifecycle. The download
restriction applies to the existing app interface. Gmail delivery remains
unverified until the credentials and live app URL are configured.

## Verification

```sh
npm run seed:verify
npm run verify
npm run check
npm run format:check
npm run build
```

`npm run db:audit -- --company-id COMPANY_ID` validates one company on the
configured deployment without comparing deployment-specific IDs to seed IDs. Add `--seed`
to require an exact business-data match to the local seed. The local
verifier uses deterministic row identities only within verification; no second
business identity is stored. It compares all 58 frozen compositor states,
including full source/provenance signatures, pagination token conservation and
server-rendered provenance attributes; see the [reference policy](docs/overlay-rendering.md#verification).

Contract creation, immutable publication, development measurements, and the staged
rollout are documented in [the creation report](docs/contract-creation-performance.md).

Dinu uses open verified email signup and private companies. Each account creates a
company, accepts an invitation, or waits for a colleague. There is no company
discovery or email-domain autojoin. Each user chooses Rep or Admin for themselves
in Settings; Admin grants company administration immediately. New profiles start
as Rep, company creators become Admin and owner, and invitations preserve personal
roles. Ownership is independent: owners can choose Rep and still transfer ownership.
Admins invite/remove colleagues and edit company settings. Contracts stay with the company when a colleague leaves or
deletes their account, with former-colleague attribution where needed. See
[authentication configuration](docs/clerk-auth.md) and
[the schema and rollout runbook](docs/private-companies-rollout.md).

See [workspace ownership](docs/persistent-workspace.md),
[rendering](docs/overlay-rendering.md), [performance](docs/rendering-snappiness.md),
and [editor lifecycle](docs/lifecycle.md).

### Authoring behavior

“Explain a clause” starts a summary draft. “Help reps negotiate” starts a
concession draft. This choice only routes local creation; every saved box exposes
the same editing capabilities. The staged concession itself determines which
creation steps are shown, so no separate mode is serialized or sent to the backend.

Creation mode is absent from live records and immutable snapshots. Every item has
a required revision; admin creation and seed imports both start at revision 1.
Deploy the Convex schema and mutations together with the frontend after the reset.

Cold-start implementation, rollback flags, recorded evidence, and outstanding production
measurement gates are documented in [the performance report](docs/cold-start-performance.md).

The [document domain implementation report](docs/document-domain-runtime.md) records
ownership, the revision-writer audit, available verification, and open build/browser
gates for the incremental runtime refactor.

## Production-data seed restoration

The cleaned supplied Convex export is retained under `data/migration/source` as the
seed source of truth. These archives have been edited and are not byte-for-byte
originals. `npm run seed:restore-export` deterministically rebuilds both seed
files and the logical mapping. `npm run seed:reconcile` compares every record,
checks edit/save preservation, and compares generated contract output against the
old provision rules. `seed:verify` requires that reconciliation to pass.

Concessions retain optional `detail` and `after` copy; source text retains optional
bold/italic `marks`. These fields are validated, displayed, and preserved by edits.
Read [the reconciliation and cutover report](docs/production-data-reconciliation.md)
before any development rehearsal or production cutover. The seed command requires an explicit company and matching development/local
target; it cannot load production or overwrite existing edited content.
