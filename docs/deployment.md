# Production releases

**Strict local backend/client model prepared; NOT DEPLOYABLE TO AN UNVERIFIED POPULATED TARGET.** No target inventory, conversion, reset or deployment was performed by this implementation. All G01–G25 remain UNVERIFIED. Follow the [preservation cutover and concrete release kit](backend-preservation-cutover.md) before publishing this incompatible release.

The [2026-11-06 reset record](production-data-reconciliation.md) describes an earlier point in time, not current target emptiness or authorization for another reset. Configured development is `disciplined-squid-496` and production is `befitting-lyrebird-846` in `dinu-app`; verify actual targets and all obligations afresh before an authorized release. [Current architecture](data-model.md) describes the strict model.

After the release gates are cleared, push to `main` to release Dinu. Vercel builds the website and deploys Convex from
the same checkout. Automatic deployments from other branches are disabled by
`vercel.json`. Vercel's project-level **Preview Deployments** setting is also
disabled, covering branches that do not yet contain this configuration.
Existing previews remain available. Keep the release configuration on development
branches too; manual production deployments are still possible and should be avoided.

## Production configuration

| Service      | Production target                      |
| ------------ | -------------------------------------- |
| Vercel       | `dinu-app`, production branch `main`   |
| Website      | `https://dinu.juliennewman.com`        |
| Convex       | `befitting-lyrebird-846` in `dinu-app` |
| Clerk        | `ins_3LFqe1zQR22UO50Z6le0kuij55b`      |
| Clerk issuer | `https://clerk.dinu.juliennewman.com`  |

Local development selects `dev:disciplined-squid-496` in `.env.local` and uses
Clerk issuer `https://expert-seal-1242.clerk.accounts.dev`. Its deletion webhook is
`https://disciplined-squid-496.convex.site/clerk/webhook`. Keep development and
preview Clerk keys separate from the live production keys.

The target constants in [`scripts/check-deployment.mjs`](../scripts/check-deployment.mjs)
are shared by both release phases. Convex URLs and the Clerk issuer are derived there.

Vercel **Production** needs these variables:

| Variable                       | Value                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| `CONVEX_DEPLOY_KEY`            | Sensitive deployment-scoped production key; needs deployment and environment-read access |
| `PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk Production publishable key (`pk_live_…`)                                           |
| `CLERK_SECRET_KEY`             | Secret for the configured Clerk Production instance (`sk_live_…`), stored as Sensitive   |

The release command injects `PUBLIC_CONVEX_URL` into the website build from the
selected Convex deployment. An existing saved value is overridden during builds.
Never give Preview or Development the production deployment key.

Create the deployment key in the Convex dashboard for the exact target above and
copy it directly into Vercel. The CLI alternative is
`npx convex deployment token create vercel-production --deployment befitting-lyrebird-846`;
its output is a secret and must not be saved in Git or shared in logs.

Convex Production requires `CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER_DOMAIN`,
`CLERK_WEBHOOK_SIGNING_SECRET` and `APP_URL` for identity, webhook and link configuration.
Email activation additionally configures `LOOPS_API_KEY`, `LOOPS_INVITATION_ID`,
`LOOPS_APPROVAL_ID` and `LOOPS_DECISION_ID`; see [email delivery](email-delivery.md).
The Clerk secret belongs to the same production instance as Vercel's key; the two
secrets may differ, allowing independent key rotation. Each distinct key is checked
against the expected instance. The issuer matches the table above, and `APP_URL`
is the website origin. Loops secrets stay in Convex; the sender local part belongs
in the template-publisher environment. The current release checker does not
validate Loops IDs, template publication or delivery. Remove obsolete SMTP and
whole-body-wrapper values during authorized email activation. Required checker values
must have no leading or trailing whitespace; their raw values are never trimmed.

During setup, verify the enabled Clerk `user.deleted` webhook destination is
`https://befitting-lyrebird-846.convex.site/clerk/webhook`, and store its signing
secret in Convex. Use Clerk's `convex` JWT template with audience `convex` and
standard RS256 signing. The checker also requires `email` to be
`{{user.primary_email_address}}` and `email_verified` to be
`{{user.email_verified}}`, as documented in [Clerk authentication](clerk-auth.md).

## What happens on a release

Vercel runs the `buildCommand` in `vercel.json`:

1. Convex selects the production backend and supplies its URL to the build command.
2. `scripts/check-deployment.mjs preflight` checks production keys, instance,
   domain, Convex environment, JWT template including required identity claims,
   and OpenID issuer. It does not call the existing webhook endpoint.
3. `npm run build` runs the existing Svelte/type checks and builds the website.
4. Convex type-checks and deploys the backend, recording the Git commit SHA.
5. `scripts/check-deployment.mjs smoke` checks the newly deployed webhook endpoint.
   This phase derives its URL from the shared target: Convex's injected
   `PUBLIC_CONVEX_URL` exists only inside the earlier `--cmd` child process.
6. Vercel publishes the website only after the smoke checks succeed.

Configuration or website build failures stop the release before backend deployment.
Convex deployment or subsequent smoke-check failures prevent website publication.
Each checker phase has a 60-second deadline; each request has a 15-second timeout
covering response reading. Independent reads run concurrently and outstanding
requests are cancelled when a check fails. Network failures, timeouts, HTTP 429,
and HTTP 5xx receive at most two retries. `Retry-After` is honored when present;
if its delay cannot fit within the remaining phase deadline, the check fails.
Other HTTP failures and invalid JSON are not retried.

Each phase that needs Convex settings reads them once through the documented
[deployment environment API](https://docs.convex.dev/deployment-api/list-environment-variables).
Missing required values, including secrets, fail the check. Clerk checks use direct
HTTP requests. Diagnostics identify the operation and failure category or HTTP
status; credential values and raw API responses or exceptions are never printed.

The smoke phase sends three `configuration.check` events: one without signature
headers (HTTP 400), one with a well-formed signature for different body bytes
(HTTP 400), and one with the correct signature (HTTP 204). These inert events do
not change application data. Moving them after deployment lets a release repair
a broken endpoint and checks the new code before website publication. The checks
do not inspect Clerk's configured destination or prove delivery from Clerk.
The release does not change Clerk dashboard settings.

Vercel's ordinary Git build queue processes a branch sequentially; intervening
queued commits may be skipped in favor of the latest. Avoid simultaneous manual
production deployments or deploying Convex separately.

## Failures and recovery

The deployments are not atomic. Convex can update before Vercel publishes, and
open browser tabs can still use older frontend code. Release matching supported clients and fence old served/open/offline protocols before removing their backend surfaces. The [preservation cutover](#backend-ownership-conversion) releases the verified converted schema/data/client set together; routine build checks do not enforce its population or job gates.

If preflight fails, fix the named production setting or retry after a transient
service failure, then redeploy the same commit. Do not bypass the checker.
If smoke fails, the log explicitly reports that Convex has already deployed and
Vercel publication is blocked. The previous website is still serving against the
updated backend. Repair the endpoint or configuration and rerun the complete
release. The same recovery applies if Vercel fails to publish after smoke succeeds.

A source revert can roll back code only when the stored representation and supported clients still match it. After preservation conversion, source-only or Vercel-only rollback is insufficient. Follow the release kit: restore matching code/client, database, files and components with scheduler and external-outcome reconciliation, or complete forward under the original fences. Reverting source never reverses a provider effect.

Local `npm run dev` and `npm run build` are unchanged. Local development continues
to use its existing configuration rather than the production release checker.

Integration content ships with the website from `src/lib/integrations.ts`; no catalog initialization is required. Before the first static-catalog publication on a target, compare its stored editorial content with the shared code snapshot. Before deploying removal of the former catalog APIs, establish that supported served/open clients no longer need them. If clients remain or their status is uncertain, first publish the static frontend while retaining the old catalog backend/schema, then remove those APIs after client retirement. Legacy stored records need no cleanup for the application to work. See [integration catalog](integrations.md) for the transition and content maintenance.

<a id="backend-ownership-conversion"></a>

## Preserved data and matching client cutover

The local model has one authoritative contract root and approved document, canonical `playbook | buyer-link` changes with exact current/applied heads, independent review groups, explicit template audiences, bounded operation replay and independent output evidence. Retired publication/terminology converters and old callbacks are absent from the application. Historical runbooks describe superseded models.

Use the [preservation-first release procedure](backend-preservation-cutover.md) and its exact outside-repository offline bundle/runbook. For a populated current-schema target, preserve and convert original owners/history without command replay or template recapture. Older/unknown schemas stop release for an actual-schema preservation/disposition plan. A mid-terminology target finishes with its preserved old bundle first. Empty targets still require verified emptiness, external obligations, component keys and old job/client fences. Reset requires its own explicit authorization and coherent recovery/disposition record.

All G01–G25 remain UNVERIFIED. Old callback signatures, current-activity catch-up for advanced company/account markers, real witness/refill deadlines, output/seal/native/cleanup mappings and exact provider/canonical/CSM obligations are mandatory release evidence. No target action occurred locally. Browser namespaces are disposable `dinu:v8` (IndexedDB 16), `dinu:drafts:v6` envelope 12 and independent `dinu:download-acks:v2`. Old envelope 10/11 and malformed originals stay blocked/recoverable for review/export; they are never retimestamped or replayed. Cache invalidation is not intent retirement. New deliberate requests receive `op1` IDs; retry preserves the original ID/input and its seven-day deadline.

Manual acceptance includes the same approved document in all audiences, permitted immediate changes beside unrelated pending work, exact review/support/undo and context requests, logically removed discussions with immediate unread cancellation, output-owned evidence, current displayed-byte buyer downloads, concurrent command/retry/account boundaries, warm navigation and shared copy feedback. Local type/build/tests cannot certify visual/native provider behavior or old running jobs. Preservation conversion and deployment remain separately authorized release steps; reset requires its own explicit decision.

Template authoring and external integration maintenance have independent live procedures:

Before changing generation resolution on a target, inventory current manifests,
pointer clocks, acknowledged watermarks and active `authoringMigrations` captures.
Present manifest clocks now own observations, readiness, saves and repair; only
genuinely missing historical fields fall back to the corresponding pointer clock.
Classify divergences against retained capture/watermark history and reconcile
deliberately so acknowledged company clocks never decrease. Do not take a runtime
maximum or reset clocks. An older active capture whose clock semantics differ must
restart through `authoringMigration:begin` and complete certification; version,
source and fingerprint fences remain. Pointer clocks remain output mirrors during
compatibility. Remove their fields/writes only after historical missing-clock
manifests and older captures are proven retired; this local implementation does
not establish those population gates or remove the mirrors.

- Cal booking rollout uses the bounded `csmMaintenance:normalize` dry-run/apply
  populations (`attempts`, `appointments`, `companies`), retaining every unresolved
  ID/reason and converted-unknown/recovery-enrollment delta. Old receipt/snapshot
  maintenance APIs are removed. Apply reuses current reducers, schedules GET recovery
  only, and preserves lease/backoff/review/budget. Missing original proof stays
  guarded review. A separately authorized complete attempt inventory/apply is required
  before relying on affected historical initial-setup/support admission, including
  already-format2 provider-negative failures with missing/invalid sender execution
  tokens (`canceled`, `unknown`, `pending` or `inProgress`). These convert to guarded
  unknown/review while retaining lineage and recovery history; only `success`/`failed`
  execution with the required UID/operator evidence retains negative authority.
  Deployment alone does not repair stored rows; no live inventory/apply occurred
  during local implementation. See the [normalization and reviewed-recovery runbook](assisted-template-setup.md#snapshot-and-reference-reconciliation).
- Before Cal rollout, verify actual numeric event/organizer IDs and API scope. Set
  `CAL_EVENT_TYPE_ID`, `CAL_ORGANIZER_ID`, `CAL_API_KEY`, dedicated
  `CAL_METADATA_SIGNING_SECRET`, and delivery-only `CAL_WEBHOOK_SECRET`. Preserve
  the old delivery key as `CAL_LEGACY_METADATA_SECRET` before rotation; there is no
  fallback to the current key. Setup/support share one event. Frozen references
  survive delivery/signing-key changes; signing rotation affects new attempts only.
- Release matching booking backend/client and retire old tabs; no receipt-protocol
  negotiation or old context/settlement client API remains. Keep additive historical
  schema/readers/verifiers until inventories are empty or unresolved obligations
  safely retained/converted, old scheduled invocations drained and old issued URLs
  accounted for. Drain wrappers `csmBookings:recoverWebhook` and
  `csmSetupAppointments:legacyWebhook` only forward into the durable inbox.
- Initial/replacement setup recovery is sanitized and company-authorized, using
  original attendee proof. Webhook acknowledgement follows durable local retention,
  with no provider IO in HTTP. Finite retry/review preserves uncertainty; erased
  dispatch guards require exact terminal-before-investigation evidence, and positive
  erased discovery stays closed without personal reconstruction. Appointment
  cap/overflow resolution requires exhaustive attestation and fresh fenced proof.
  Template release retires appointment work while retaining history/confirmed facts
  and independent creation recovery. No provider invitations are cancelled.
- Confirmed scheduled/cancelled header facts survive failed refresh. Scheduled
  notices end at the confirmed call end; cancellation lasts until confirmed
  rebooking/release. There is no unknown-status header. Cold display retains
  concurrent config/slot GETs and the browser cache. No provider-wide exactly-once
  or slot reservation is claimed. Live provider/scheduler/key rotation, browser,
  inventory/apply and env/deployment checks are separate rollout prerequisites,
  unperformed by local implementation.
  No old `contractState:normalizeBatch`, `contractDefinitions:backfillProposals`,
  `operationReceipts:migrateLegacy` or their removed retirement endpoints should be invoked.
  Booking maintenance and external-delivery release checks above are still required
  where their stored populations exist. Run any live operation only under its own authorized
  target/rehearsal/recovery procedure.

## Verification

Before release, run `node --check scripts/check-deployment.mjs`,
`npm run verify` and `npx tsc --noEmit -p src/convex/tsconfig.json`.
These verify script syntax, the existing lifecycle/performance/integration checks,
frontend/backend type checks and the production build. They do not automatically
exercise release-checker retry, deadline or configuration-failure paths, or native
resource/provider/browser acceptance.

After the first release, verify the Vercel production commit matches the Convex
deployment message and the build log reports both `Production preflight checks
passed.` and `Production smoke checks passed.` in the documented order.
Confirm a subsequent branch push produces no automatic preview deployment.
Manually check login and one backend operation at the production website.
These checks do not certify email delivery, end-to-end Clerk webhook delivery,
or compatibility of every future API change.
