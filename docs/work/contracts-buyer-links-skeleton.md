# Contracts buyer-link loading presentation

Scope: implement the approved conditional buyer-link skeleton without changing link eligibility, search, pagination, or clipboard feedback.

Decisions:

- Extend the existing session-owned presentation hints with a boolean; persist no link names, URLs, tokens, or counts.
- Scope presence to deployment/user plus membership/company. Live account changes invalidate mismatched hints; ordinary sign-out retains the remembered hint.
- Rows establish presence. Only an error-free, exhausted empty query establishes absence; pending and filtered intermediate pages do not.
- Use the same hint at outer loading boundaries and inside the mounted Contracts page. Unknown presence keeps the common full-width layout.
- Match the loaded sidebar's 450px desktop column, 24px gap, mobile stacking, heading, and row geometry. Keep contract readiness independent of buyer-link loading.

Evidence: `Contracts.svelte`, `buyerLinks.ts:browse`, the existing workspace-role hint owner/storage, and `docs/account-routes.md`.

Completed:

- Generalized the existing role owner/storage as `workspace-hints`, retaining the storage key and role lookup. Matching live membership confirmation preserves presence; changed scope and membership loss clear it.
- Added the reusable buyer-link skeleton and wired it into both Contracts loading stages.
- Updated account route documentation. Existing buyer-link eligibility, pagination, error feedback, contract readiness, and clipboard path remain intact.
- `npm run test:perf`: 39 passed (saving, caching, creation, and startup guarantees).
- `npm run check`: zero Svelte errors/warnings; tools type check passed.
- `npm run test:loading:ssr`: 5 passed (authenticated and public loading render/stream guarantees).
- Existing `home-snappiness.test.ts`: 5 passed (startup scope, immediate cards, search retention, deferred warming).
- Production `vite build` and `npm run verify:loading-bundles` passed.

Complete. No new tests or browser checks. New hint transitions and visual layout remain manually unverified. First visits without a remembered hint can still shift once links arrive. Logs: `/tmp/oceans-contracts-skeleton-{perf,check,ssr,home,build,bundles}.log`.
