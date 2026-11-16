# Buyer link code cutover

Status: Phase 3 complete in the working tree. Phase 4 readiness inspected; traffic pause, database wipe, deployment, and verification remain pending.

## Code and URL contract

- A buyer code is exactly 13 ASCII characters from `A–Z`, `a–z`, and `0–9`. All 62 characters are allowed. Case is significant, and a code must never be lowercased, uppercased, or parsed as a number.
- The canonical buyer URL is `/<code>`, with no `/buyer` prefix or `/contract` suffix. Generated links, copied links, and email links all use this URL.
- The root path namespace matching exactly 13 ASCII base62 characters belongs to buyer links. New non-buyer root paths must not claim one of these paths.
- Each code is an opaque bearer credential for one permanent buyer link. It stays stable when that link's approved document changes. Do not put the code in logs or other public metadata.
- Generate each character uniformly with a cryptographically secure random source, using rejection sampling to avoid modulo bias. The resulting code has about 77.4 bits of entropy. Check the indexed token lookup before insertion and retry on a collision; never replace an existing link.
- Route matching and backend lookup accept only this exact 13-character code format. The old 39-digit and 43-character formats, `/buyer/<token>` pages, and `/<code>/contract` page alias are removed at cutover. There is no redirect or compatibility lookup for old links.

## Cutover boundary

The format change ships with the route, generation, lookup, and email changes, followed by the planned database wipe before traffic resumes. Previously issued buyer URLs stop working permanently. The wipe also removes old buyer link records, so no token migration is needed.

Phase 1 changes only this decision record. Implementation and verification belong to later phases.

## Progress

- Phase 2: Generation, validation, public routing, copied links, and email URLs use the 13-character code and canonical root URL. The old buyer page routes are removed. The existing indexed collision check and retry remain in place.
- Phase 3: Existing buyer fixtures and route assertions use mixed-case 13-character codes and the canonical root URL. Automated tests remain deferred until the end of the plan as requested.
- Phase 4: Pause traffic, wipe the database, and deploy the app and Convex changes together.
- Phase 5: Create and inspect a live buyer link, including seller views and email links.

## Phase 4 readiness, 2026-11-15

- The documented production target is Convex `befitting-lyrebird-846` behind the Vercel `dinu-app` production site. Read-only CLI inspection found 35 application tables; a one-row check found only the `fileSweeps` bookkeeping row populated. Its sweep is inactive. The `_storage` and `_scheduled_functions` system tables had no rows, and one-row checks found no rows in either mounted component's tables. This is a limited inventory, not clearance of external obligations, old clients, or the G01–G25 release gates in `docs/backend-preservation-cutover.md`.
- The buyer-link cutover is uncommitted in a working tree with extensive other changes. Production deploys from a commit on `main`, so pushing the current branch as it stands would not release the cutover. A reviewed release commit and scope are required before a traffic pause.
- The production release procedure in `docs/deployment.md` calls for verification before publication. Automated tests were explicitly deferred until the end of this plan; none were run here. Resolve the verification order before deploying.
- No traffic was paused, no database was wiped, and no app or Convex deployment was made. Before those steps, record the selected target and reset disposition/recovery set, clear the live release obligations and old-client/job fences, prepare the exact release commit, and complete the applicable pre-release checks. Then perform the coordinated cutover and record deployment identifiers before phase 5.
