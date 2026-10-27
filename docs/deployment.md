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

Vercel **Production** needs these variables:

| Variable                       | Value                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `CONVEX_DEPLOY_KEY`            | Sensitive deployment-scoped production key named `vercel-production`; needs deployment and environment-read access |
| `PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk Production publishable key (`pk_live_…`)                                                                     |
| `CLERK_SECRET_KEY`             | Matching Clerk Production secret (`sk_live_…`), stored as Sensitive                                                |

The release command injects `PUBLIC_CONVEX_URL` into the website build from the
selected Convex deployment. An existing saved value is overridden during builds.
Never give Preview or Development the production deployment key.

Create the deployment key in the Convex dashboard for the exact target above and
copy it directly into Vercel. The CLI alternative is
`npx convex deployment token create vercel-production --deployment befitting-lyrebird-846`;
its output is a secret and must not be saved in Git or shared in logs.

Convex Production retains `CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER_DOMAIN`,
`CLERK_WEBHOOK_SIGNING_SECRET`, `APP_URL`, `SMTP_USER`, and `SMTP_APP_PASSWORD`.
The Clerk secret matches Vercel, the issuer matches the table above, and `APP_URL`
is the website origin. SMTP credentials stay in Convex.

During setup, verify the enabled Clerk `user.deleted` webhook destination is
`https://befitting-lyrebird-846.convex.site/clerk/webhook`, and store its signing
secret in Convex. Use Clerk's `convex` JWT template with audience `convex` and
standard RS256 signing. Retain the identity claims documented in
[Clerk authentication](clerk-auth.md).

## What happens on a release

Vercel runs the `buildCommand` in `vercel.json`:

1. Convex selects the production backend and supplies its URL to the build command.
2. `scripts/check-deployment.mjs` checks production keys, instance, domain, Convex
   environment, JWT template, OpenID issuer, and webhook signature handling.
3. `npm run build` runs the existing Svelte/type checks and builds the website.
4. Convex type-checks and deploys the backend, recording the Git commit SHA.
5. Vercel publishes the website.

Missing configuration, failed requests, or mismatches fail the build before
backend deployment. Backend deployment failure prevents website publication.
Requests have timeouts; transient failures receive at most two retries. Credential
values and raw API/CLI errors are never printed by the configuration checker.

The webhook check sends an unsigned event (expecting rejection) and a signed
`configuration.check` event (expecting HTTP 204). Neither performs data changes.
It checks the currently running endpoint; it does not inspect Clerk's configured
destination, prove delivery from Clerk, or validate new webhook code before deployment.
The release does not change Clerk dashboard settings.

Vercel's ordinary Git build queue processes a branch sequentially; intervening
queued commits may be skipped in favor of the latest. Avoid simultaneous manual
production deployments or deploying Convex separately.

## Failures and recovery

The deployments are not atomic. Convex can update before Vercel publishes, and
open browser tabs can still use older frontend code. Keep backend changes
compatible with those clients, even when the database is empty.

If the preflight fails, fix the named production setting and redeploy the same
commit. Do not bypass the checker. If the website fails to publish after Convex
succeeds, repair and rerun the complete release.

To roll back application code, revert the affected changes while retaining this
deployment configuration, then push to `main`. That releases both parts from the
reverted source. A Vercel-only rollback does not roll back Convex. This procedure
does not migrate or restore data; migrations and backups are outside this setup.

Local `npm run dev` and `npm run build` are unchanged. Local development continues
to use its existing configuration rather than the production release checker.

## Verification

After the first release, verify the Vercel production commit matches the Convex
deployment message and the build log reports that configuration checks passed.
Confirm a subsequent branch push produces no automatic preview deployment.
Manually check login and one backend operation at the production website.
These checks do not certify email delivery, end-to-end Clerk webhook delivery,
or compatibility of every future API change.
