# Contract link and discussion repair

## Scope and decisions

- Implement approved plan: accurate buyer-link reads, discussion occupancy, no loading-discussions box, development reset and fresh Oceans verification.
- Development only: `disciplined-squid-496`. Preserve Clerk accounts and deployment configuration; discard development application data and old contract drafts.
- No historical publication reconstruction, new tests, browser checks, or unrelated source cleanup.
- Preserve all existing dirty changes. Original affected files copied to `/tmp/oceans-contract-repair-before` for change isolation.

## Evidence

- Existing Oceans contract lacked `contractBuyerState`; link capture fails before clipboard.
- Current `contracts.createContract` already calls publication initialization in its transaction; investigate deployed parity and verify fresh creation.
- `DocumentViewer` reserves space for a session object; desktop geometry also reserves panel width unconditionally.
- `DiscussionLayer` renders a loading footer before any thread is known and indexes empty documents.
- Buyer-link bar conflates unresolved reads with confirmed absence.

## Progress

- Re-read repository instructions and Convex guidelines; implementation authorized by user.
- UI implemented: distinguish link read states and bounded errors; reserve discussion geometry only for cards/composer; remove loading box; retain compact pagination/retry; skip empty annotation indexing.
- Added bounded publication integrity evidence to `contractState.retirementPage`.
- Both manual and HubSpot creation already call the shared atomic publication writer. No creation rewrite needed.
- Production build, Svelte checks (zero errors/warnings), tool types and Convex types passed. All 37 performance checks passed.
- Standard `seed:verify` failed in an unrelated, preexisting SSR fixture (`RepPlaybookPanel` receives an item without `origin`). No assertion weakened or unrelated fix applied.
- Saved current uploaded template/playbook via authorized `templates.content` and validated business projections: 248 blocks, 1 item. `operator.readSeed` is seed-only and correctly refuses a DOCX source; using captured business content with existing bootstrap instead.
- Root and both components had no pending/in-progress jobs; HubSpot work table empty. One storage file belongs to discarded setup.
- Published current workspace backend to pinned development target with Convex typecheck; no production action.
- Root `--replace-all` import cleared all application tables and component data (including retired workflow components), so separate component imports were unnecessary.
- Recreated profile/company using normal onboarding APIs; restored captured setup with `operator.bootstrap` and checked exact live/historical content round trip. Removed the unowned old upload.
- Created fresh Oceans through `contracts.create`, then ran `buyerLinkActions.ensureLatest` twice: same permanent link returned. Latest-link read, unauthenticated status/content and empty buyer discussion feed all verified.
- Paged publication integrity evidence through completion: all legacy/inconsistency lists empty.
- Fresh IDs: company `jn78x5e55j7x3skcwqq5r6w9th8hzg3p`, membership `m5765y35frjzjz35g7b3mt4tsx8hzze4`, Oceans `mn70n5p5f1ht3g41hw1st1wk198hyp1h`.
- Development server running on port 5173. Copied the verified buyer URL to the system clipboard; this does not verify browser clipboard permissions or the rendered confirmation.
- Exact deployment/API evidence and preserved setup are in `/tmp/oceans-contract-repair-before/verification.json` and `workspace-setup.json` (local only).

## Remaining manual acceptance

- No browser checks or automation performed. User checks seller/buyer layout, incoming first comments, composer/cancel, populated threads, pagination/errors, inspector/mobile transitions and clipboard confirmation.
- Browser storage was not physically purged remotely. Fresh profile/membership IDs isolate old snapshots and prevent discovery/replay of old membership drafts; existing account lifecycle clears caches on observed scope transitions. Physical removal of old browser entries remains unverified.
- Standard seed verifier's unrelated SSR fixture failure remains; current real template/playbook validation and exact bootstrap round trip passed.
