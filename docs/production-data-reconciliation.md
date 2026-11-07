# Production data reconciliation

**Clean reset, 2026-11-06.** Dinu development `disciplined-squid-496` and
production `befitting-lyrebird-846` were cleared and deployed with the current
schema and functions. Both have 22 current application tables with no documents,
stored files, component data or pending application jobs. Clerk has no users,
organizations or pending invitations in either environment. No seed was restored.
The development and production Clerk instances remain separate. This reset
supersedes the seeded activation described below.

**Historical static-table activation, 2026-11-05.** Development
and production were reset, deployed with the strict
schema, and reseeded. Every legacy application table is gone; each deployment
then had the same 27 canonical tables. Rate-limiter component data was cleared,
pending application work canceled, and uploaded files removed. Clerk users and
deployment settings were retained. Fresh profiles, owner memberships, and the
company were created using each environment's existing verified Clerk account.

The current seed has **112 blocks, three static tables, 55 items, 21 concessions,
and 29 changes**. The monthly-fee discount rule and its five concessions/changes
are retired. Both deployed seed reads exactly match the local baseline, playbook,
and immutable template version. Account reads confirm owner/admin access and a ready
template. Local verification passed 48 compositor states, 23 performance checks,
frontend/backend type checks, and the production build. Browser visuals, search
highlight geometry, live DOCX upload, and third-party Word rendering remain
unverified. Frontend source is prepared locally; no website publication was made
as part of these database operations.
