# Dinu

A SvelteKit / Svelte 5 contract workspace backed by Convex.

For production configuration and the coordinated Vercel/Convex release process,
see [Production releases](docs/deployment.md).

The immutable contract source is separate from the Playbook. A Playbook Item has
one Trigger, optional instructions, an explicit approval policy, and negotiation concessions. Each
concession applies an atomic set of source-coordinate Contract Changes.

`/` owns a `RepWorkspace` and `RepPlaybookPanel`. `/admin` owns an `AdminWorkspace`
and `PlaybookEditor`. Both share the document viewer, chrome and rendering
machinery. The viewer receives only the derived document overlay, not instructions,
draft state or save operations.

Admins select unowned source to create an item or click a Trigger to edit its
complete item. One local draft supports instructions, a Trigger, preferred
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

Node.js 24 is required.

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
The canonical bootstrap data is `data/convex`: 112 immutable blocks and
55 Playbook Items, containing 55 Triggers, 21 concessions and 29 changes.
The seed command refuses to overwrite edited runtime records and resumes an
interrupted items-first import. It only loads initial company templates.

The [current data model](docs/data-model.md) explains ownership, revisions, approval
applications, and lifecycle owners. See [production releases](docs/deployment.md)
for deployment; an ordinary deployment does not migrate existing data.

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

## Approval and invitation email

Approval requests, decision summaries, and invitations use Loops transactional
email templates. Configure these Convex backend environment variables on each
intended deployment (never as public SvelteKit variables):

| Variable              | Value                                                                |
| --------------------- | -------------------------------------------------------------------- |
| `LOOPS_API_KEY`       | Loops API key                                                        |
| `LOOPS_INVITATION_ID` | Invitation transactional template ID                                 |
| `LOOPS_APPROVAL_ID`   | Approval request transactional template ID                           |
| `LOOPS_DECISION_ID`   | Review decision transactional template ID                            |
| `APP_URL`             | Website origin, such as `https://dinu.co` or `http://localhost:5173` |

`npm run email:setup` provisions and checks the Loops templates. Set each company's
approval recipient in Settings. Backend configuration requires an HTTP(S) app
origin without credentials, a path, query, or fragment. Missing configuration
causes a failed delivery without sending a provider request.

An applied concession requires approval when its captured playbook item's
`approvalPolicy.kind` is `required`. The existing “Changes need to be approved”
text editor sets that policy for nonblank guidance and clears it when empty. Pending or rejected
concessions block Word download. Approval decisions belong to the saved application
lifecycle, and changing selections advances the review generation. Approval requests
capture the company name, recipient, and concession details. Their workspace link
is `APP_URL/contracts/<contract ID>?review=1`.

All senders share `emailDeliveries` and its dispatch, completion, recovery, retry,
and cancellation rules. Immutable descriptions are stored in bounded
`emailSelectionChunks` chunks. Recipients and access are checked again before dispatch.
The provider receives an idempotency key scoped to the deployment, delivery, and
attempt. A successful response confirms provider acceptance; inbox delivery still
requires manual verification.

Decision summaries retry known safe failures up to three total attempts. An
ambiguous result after sending starts is uncertain and cannot be automatically
resent. Explicit retry is available after the uncertainty cooldown and completion
of the original job. Internal `emailDeliveries:retry` retries an eligible failed
decision delivery. Delivery ID and attempt checks prevent old workers from
completing a newer attempt. Contract and company deletion cancel tracked work and
remove associated snapshots. An accepted email cannot be recalled.

Invitation batches use five workers and a four-minute cancellation deadline.
Invitation expiry jobs are canceled when an invitation is replaced, accepted,
revoked, or deleted. Diagnostics exclude credentials, message bodies, addresses,
and raw provider responses.

There is no email migration step. Deploy the current schema and functions together
against a database containing only the current data formats.

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
business identity is stored. It compares the frozen compositor states,
including full source/provenance signatures, pagination token conservation and
server-rendered provenance attributes; see the [reference policy](docs/rendering-snappiness.md#verification-and-limits).

Dinu uses open verified email signup and private companies. Each account creates a
company, accepts an invitation, or waits for a colleague. There is no company
discovery or email-domain autojoin. Each user chooses Rep or Admin for themselves
in Settings; Admin grants company administration immediately. Roles belong to company memberships. Company creators become Admin and owner;
new invitees start as Rep. Accounts without a company have no stored role. Ownership is independent: owners can choose Rep and still transfer ownership.
Admins invite/remove colleagues and edit company settings. Contracts stay with the company when a colleague leaves or
deletes their account, with former-colleague attribution where needed. See
[authentication configuration](docs/clerk-auth.md) and
[the schema and rollout runbook](docs/private-companies-rollout.md).

See the [data model](docs/data-model.md), [rendering](docs/rendering-snappiness.md),
and [editor lifecycle](docs/lifecycle.md).

### Authoring behavior

“Explain a clause” starts a summary draft. “Help reps negotiate” starts a
concession draft. This choice only routes local creation; every saved box exposes
the same editing capabilities. The staged concession itself determines which
creation steps are shown, so no separate mode is serialized or sent to the backend.

Creation mode is absent from live records and immutable snapshots. Every item has
a required revision; admin creation and seed imports both start at revision 1.
Deploy the Convex schema and mutations together with the frontend after the reset.

## Production-data seed restoration

The cleaned supplied Convex export is retained under `data/migration/source` as the
seed source of truth. These archives have been edited and are not byte-for-byte
originals. `npm run seed:restore-export` deterministically rebuilds both seed
files and the logical mapping. `npm run seed:reconcile` compares every record,
checks edit/save preservation, and compares generated contract output against the
old provision rules. `seed:verify` requires that reconciliation to pass.

The seed generator produces the same text and boundary target format used by
runtime records. Archived inline bold/italic formatting is discarded; concessions
store their current description and contract changes.
See the [current seed and activation status](docs/production-data-reconciliation.md). The seed command requires an explicit company and matching development/local
target; it cannot load production or overwrite existing edited content.
