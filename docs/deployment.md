# Production releases

Push to `main` to release Dinu. Vercel builds the website and deploys Convex from
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

The target constants in [`scripts/check-deployment.mjs`](../scripts/check-deployment.mjs)
are shared by both release phases. Convex URLs and the Clerk issuer are derived there.

Vercel **Production** needs these variables:

| Variable                       | Value                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `CONVEX_DEPLOY_KEY`            | Sensitive deployment-scoped production key named `vercel-production`; needs deployment and environment-read access |
| `PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk Production publishable key (`pk_live_…`)                                                                     |
| `CLERK_SECRET_KEY`             | Secret for the configured Clerk Production instance (`sk_live_…`), stored as Sensitive                             |

The release command injects `PUBLIC_CONVEX_URL` into the website build from the
selected Convex deployment. An existing saved value is overridden during builds.
Never give Preview or Development the production deployment key.

Create the deployment key in the Convex dashboard for the exact target above and
copy it directly into Vercel. The CLI alternative is
`npx convex deployment token create vercel-production --deployment befitting-lyrebird-846`;
its output is a secret and must not be saved in Git or shared in logs.

Convex Production retains `CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER_DOMAIN`,
`CLERK_WEBHOOK_SIGNING_SECRET`, `APP_URL`, `SMTP_USER`, and `SMTP_APP_PASSWORD`.
The Clerk secret belongs to the same production instance as Vercel's key; the two
secrets may differ, allowing independent key rotation. Each distinct key is checked
against the expected instance. The issuer matches the table above, and `APP_URL`
is the website origin. SMTP credentials stay in Convex. Required checker values
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
open browser tabs can still use older frontend code. Keep backend changes
compatible with those clients, even when the database is empty.

If preflight fails, fix the named production setting or retry after a transient
service failure, then redeploy the same commit. Do not bypass the checker.
If smoke fails, the log explicitly reports that Convex has already deployed and
Vercel publication is blocked. The previous website is still serving against the
updated backend. Repair the endpoint or configuration and rerun the complete
release. The same recovery applies if Vercel fails to publish after smoke succeeds.

To roll back application code, revert the affected changes while retaining this
deployment configuration, then push to `main`. That releases both parts from the
reverted source. A Vercel-only rollback does not roll back Convex. This procedure
does not migrate or restore data; migrations and backups are outside this setup.

Local `npm run dev` and `npm run build` are unchanged. Local development continues
to use its existing configuration rather than the production release checker.

## Verification

Before release, run `node --check scripts/check-deployment.mjs` and `npm run build`.
These verify script syntax and the existing website type checks/build; they do not
automatically exercise retry, deadline, or configuration-failure paths.

After the first release, verify the Vercel production commit matches the Convex
deployment message and the build log reports both `Production preflight checks
passed.` and `Production smoke checks passed.` in the documented order.
Confirm a subsequent branch push produces no automatic preview deployment.
Manually check login and one backend operation at the production website.
These checks do not certify email delivery, end-to-end Clerk webhook delivery,
or compatibility of every future API change.
