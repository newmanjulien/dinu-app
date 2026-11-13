# Help preferences and seller buyer preview

Status: implemented locally after approval. Build and the existing performance suite
passed; see [implementation progress](help-preferences-progress.md). Browser checks,
deployment, and database reset remain outside this implementation.

## Intended behavior

All Help variants use the same modal and explicit opening/preference policy:

| Context | Automatic opening | “Don't show this again” | Preference scope |
| --- | --- | --- | --- |
| Seller's rep contract view | Once per opening unless hidden | Yes | Account profile, rep flag |
| Seller's normal buyer-link view | Once per opening unless hidden | Yes | Account profile, buyer flag |
| Seller's View as buyer preview | Never | No | No preference changes from preview |
| Actual buyer on a buyer link | Once per opening unless hidden | Yes | Browser-local, specific to that link |
| Template and buyer-template | Never | No | None |

Manual rail Help remains available when the document is ready in every context,
including preview and while account/preference readiness is pending. Seller
preferences must synchronize across browsers and devices. Hiding buyer Help on
one seller link therefore hides it on every seller link for that account; rep
and buyer flags remain independent. Existing seller recognition determines the
audience: a signed-in visitor who is not a seller for the link retains actual
buyer behavior.

## Implementation sequence

1. **Add the two required account preferences and authenticated setter.**
   In `src/convex/schema.ts`, add required
   `profiles.helpPreferences: { rep: boolean, buyer: boolean }`, where `true`
   means hide automatic Help. Initialize both flags to `false` in
   `profiles.initialize`. Add a mutation in `src/convex/profiles.ts` accepting
   only the validated `rep`/`buyer` variant and hidden boolean, with explicit
   arguments and return validators. Derive the profile with
   `requireProfile(ctx)`; accept no caller/profile/membership identity argument.
   Read and patch the selected flag atomically while preserving the other flag.
   The profile is the persistent scope, independent of company, membership,
   session, and link.

2. **Deliver private preferences through existing reactive reads.**
   Add the preferences as a required top-level field in
   `src/convex/accountViews.ts`'s `accountView`, its
   `src/convex/accounts.ts` `readViewer` result, and the private
   `src/convex/buyerLinks.ts` `sellerContext` validator/result. Keep
   `profileView` and colleague/member responses unchanged: those shared views
   must not expose another person's preferences. Reuse the existing account and
   seller subscriptions for cross-device updates; add no separate query,
   preference table, cache, or registry.

3. **Give Help a small shared session with stable ownership.**
   Replace `useHelpPreferenceScope` and modal-side storage lookup with a single
   reactive Help session/read-write interface consumed by `DocumentTools` and
   `HelpModal`. Keep the state limited to the resolved policy/preference,
   whether the initial opening decision has been handled, modal opening state,
   and pending/error write state.

   Own the buyer session on the existing `BuyerContract` created in
   `BuyerShell`; pass it through `BuyerDocument`. Own the rep session in
   `RepWorkspace` and pass it through `WorkspaceChrome`. Template variants use
   the same manual-only policy without preference storage. Do not put the
   buyer session inside `DocumentTools`, `BuyerDocument`, or a keyed host:
   `BuyerContract.configure` releases the renderer on source/preview/version
   changes, and `BuyerContractPage` keys that host by `contract.generation`.
   Keep the opening decision and pending/error writes through those remounts.

   Start a fresh session on a new document/link opening or confirmed account
   change; source/version generations, preview toggles, preference updates,
   and temporary classification delays do not create new sessions. Adopting
   the first resolved audience must preserve a manual opening already handled
   while readiness was pending. Use the profile ID for seller preference
   identity and separate captured session/client generations to reject obsolete
   asynchronous completions. No map of past openings is needed.

4. **Wire audience adapters and make opening transitions explicit.**
   `WorkspaceChrome` supplies the authenticated account's rep preference and
   workspace client. On buyer routes, resolve checking/unavailable, seller,
   preview, and actual buyer from `BuyerSeller.phase`, `presentation`, and
   profile identity. Do not infer actual buyer from `seller.visible === false`,
   because preview deliberately hides seller controls. Checking/unavailable
   classification must not read or write anonymous preferences.

   Normal sellers read `seller.viewer.helpPreferences.buyer` and write through
   `BuyerSeller.client`. Keep the buyer route's public Convex provider anonymous.
   Do not send this personal preference through the proposal/deal mutation
   helper or its content-editing gate. Confirmed actual buyers use the existing
   server-provided token hash as a local-storage link scope, under a fresh
   explicit buyer-link Help namespace. Replace the old seller/local scope code;
   do not read old keys or write both formats.

   In `DocumentTools`, separate manual availability from the initial automatic
   decision. Once document and preference/classification readiness permit,
   handle that decision exactly once and open only if policy allows and the
   preference is not hidden. Opening Help manually immediately handles any
   pending automatic decision, for both rep and buyer Help; later readiness
   cannot reopen a modal the user has closed. Preview handles/suppresses the
   same decision, closes any Help already open on entry, and permits subsequent
   manual opening without a checkbox. Returning to seller view or changing
   versions must not reopen Help. Preference subscription updates neither
   reset that decision nor close an already open manual modal.

5. **Make the shared modal a truthful view of that session.**
   Remove `HelpModal`'s independent scope resolution, `onMount` preference read,
   and direct local-storage writes. Supply its checkbox policy, confirmed value,
   setter, and pending/error state from the same resolved session used for
   automatic opening. Only eligible normal rep/buyer views show the checkbox;
   disable it until the preference is known and while saving. Await persistence
   before presenting a changed choice as saved. On failure, retain the last
   confirmed value and show a concise recoverable error inside Help; allow
   retry. Handle browser storage write failure honestly as well.

   Preview initiates no preference writes. A same-account write already started
   before preview/version remount keeps its pending/error state and may finish;
   account/client replacement must not apply its result to the new session.
   Preserve existing Help content/layout apart from the required checkbox and
   error behavior. Keep static styling inline in Tailwind classes. Preserve all
   unrelated behavior, including the complete buyer-link copy feedback path
   from `BuyerLinkController.onCopied` through `BuyerLinkCopyFeedback.show` to
   the single `CopyConfirmation` host in `WorkspaceShell`.

6. **Maintain every required creation path and affected fixture.**
   In addition to `profiles.initialize`, supply fresh defaults in direct profile
   insertions in `tests/perf/fixtures.ts`, `tests/integrations/fixtures.ts`,
   `tests/integrations/security.test.ts`, and both in-memory verifier setups in
   `scripts/reconcile-production-seed.mjs`. Update the complete viewer fixture in
   `tests/lifecycle/loading-boundaries.test.ts` and the asserted partial viewer
   in `tests/lifecycle/csm-state.svelte.ts`; a cast can otherwise hide the missing
   field. Check remaining account/seller mocks and import/creation paths for the
   new required shape, updating only affected data. Maintain existing assertions
   without adding tests or expanding coverage.

## Validation after implementation approval

- Inspect the scoped diff against the current working tree and preserve all
  unrelated edits. Trace authenticated transport selection, server-derived
  identity, private response boundaries, delayed readiness/manual opening,
  preview entry/exit, renderer remounts, account changes, and write failures.
- Run `npm run build`, which includes Svelte/type checking, tools checking, and
  the production build. Run the required `npm run test:perf` because preference
  saving and profile defaults change. Preserve its existing saving, startup,
  scheduling, and caching assertions; fix regressions rather than weakening
  them. Do not run `npm run verify` or broader suites without a specific
  unresolved need. Do not use browser automation or add tests.
- Report actual command results and the guarantees exercised. These checks can
  establish type/build compatibility and preservation of the existing
  performance-suite guarantees. They do not directly prove Help UI behavior,
  new preference authorization at runtime, live schema acceptance, or
  cross-device synchronization.
- Leave UI/live acceptance to the user: opt out on one seller link and open
  another link on another browser/device; confirm rep/buyer independence and
  account isolation; confirm preview never autoopens, closes existing Help,
  offers manual rail Help without the checkbox, and does not reopen on return;
  check manual opening before delayed readiness, version changes, actual buyer
  same/different-link local behavior, template Help, reloads, and failed saving.

## Required schema/reset ordering

The user will wipe the database separately. Before applying the required schema
to a deployment, that target must have been reset; all profile insertion paths
must include the defaults before new profiles are created. Deploy backend and
frontend with the matching required response shape. Keep any later deployment
subject to the applicable target/approval guard.

Do not add optional old-record paths, old-key reads, dual writes, seller local
fallback, backfills, or migration code. No database wipe or deployment is
authorized or executed by this planning task.
