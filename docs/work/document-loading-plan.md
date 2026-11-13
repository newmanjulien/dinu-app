# Document loading implementation plan

**Status: implemented.** Validation results and remaining manual checks are in [document-loading-progress.md](document-loading-progress.md).

Make required code and inputs available earlier for authorized template, saved-contract and buyer destinations. Preserve the renderer, fresh access checks, exact source compatibility and existing UI. Remove global font dependencies from pagination and highlights while retaining geometry safety. No backend, API, schema or deployment changes are planned.

## 1. Warm the actual destination code

Add small explicit dynamic loaders in `src/lib/auth/destination-code.ts` or adjacent code-only modules. Keep generic login/onboarding/template-setup preloading cheap. Deduplicate simultaneous imports, consume speculative failures, and allow demand loading to retry; imports must not mount components or start data/editor/activity lifetimes.

In `components/chrome/AppHeader.svelte`, authorized template pointer/focus intent, including the audience menu, warms `TemplateWorkspace`, `DocumentHost` and `document/runtime/workspace-factory`. Require usable account/company state, admin role and a ready template. Code warming does not read both audiences.

Home card intent in `contract/visible-contracts.svelte.ts` and `components/contracts/ContractCard.svelte` warms the actual `SavedContract` screen and document construction modules. Retain route-code warming where useful; `snapshot-cache.ts` currently warms only that boundary. Immediate/direct destinations still start code on demand.

Preserve `ContractRoute.prepareSaved()` and NewContract’s confirmed-preview → saved handoff. Shared loader/resource changes must keep that existing preparation and resource adoption working.

## 2. Acquire admitted template inputs independently of host mounting

Use lightweight `auth/Workspace.svelte` ownership to retain a template read lease when the selected template destination is admitted and account, company, role and template readiness permit it. This applies to direct loads. Start `templateSources.authoringSource` and only the target audience’s `playbookItems.currentStructure` independently and in parallel with heavy imports. Hover alone starts no data reads.

Extend `playbook/template-authoring-session.svelte.ts` with explicit compact-read demand independent of `attach()`, and give the source subscription one membership-scoped owner consumed by `TemplateWorkspace.svelte`. Remove its duplicate source query. Opening and mounted authoring must retain the same live subscriptions; acquire the mounted owner before releasing the opening lease.

Read demand must not select instructions, restore/discard drafts, install a controller or start optional instruction-body preloading. Editor attachment and submitted-work retention continue to own those behaviors. Audience replacement releases the old opening demand unless legitimate editor/submission ownership remains. Preserve the Settings detour’s retained owner.

Keep fingerprint, readiness, generation and transport checks before accepting source or enabling editing. Freeze/hold/access withdrawal, membership replacement and disposal stop applicable reads; stale callbacks cannot publish. Retain bounded retries and existing recovery authority. Update query-ownership documentation to reflect these distinct lifetimes.

## 3. Protect the intended saved acquisition before Home cancels it

Add a cache-owned reservation in `contract/snapshot-cache.ts` for one intended target’s **existing** acquisition and its frozen-version consumer. This is separate from `DocumentResources.beginOpen()` and editor ownership. It preserves acquisition through Home’s interaction/navigation pause without admitting rendering or promoting unrelated flights. A cold destination starts its required acquisition after guards pass.

Use two phases:

1. **Capture intent:** In Home’s existing window capture handler, resolve the actual marked card anchor and reserve its target before setting `busy` or pausing background work. Handle primary unmodified pointer activation, Enter on the anchor, and capture-click fallback. Exclude option buttons, modified clicks, external destinations and new-tab activation. Hover/focus retain current ranking and code warming. Expire this capture-only reservation after a short bounded activation window if navigation never starts.
2. **Navigation:** In `Workspace.beforeNavigate`, synchronously promote the matching reservation or replace it for programmatic/history navigation, before Kit publishes `navigating`. Cancel capture expiry and bind cleanup to that navigation’s `complete` promise, handling both fulfillment and rejection. Established navigation must not expire on the capture timer.

Keep guards unchanged and viewer admission in post-guard `onNavigate`. There, reconcile the final destination, let `cache.load()` take demand ownership of the matching live flight/version consumer, then release the reservation. Opening ownership must transfer before release; merely flipping a background flag cannot substitute for explicit release ownership.

Use an attempt token so old completion/cancel callbacks cannot release a newer target. Supersession replaces the reservation; redirects release a mismatched target and claim the final target; canceled/failed navigation releases unadopted demand. Successful navigation completion alone is not proof of adoption: either transfer first or release an unadopted reservation when its destination is no longer applicable. Hide, access loss, hold, account teardown, deletion and disposal cancel abandoned reservations. Retain existing bounded acquisition deadlines.

Preserve Home’s idle startup, visibility handling, interaction CPU pause, four download candidates (one with Save-Data), two concurrent background reads and one CPU preparation candidate. Other flights remain cancellable. Keep disk validation, immutable-cache limits, confirmed-only metadata and deletion checks. Cache cancellation and candidate-replacement paths must consistently respect reservation ownership.

## 4. Own complete saved-document inputs before activation

Add an opening lease to `contract/editors.svelte.ts`, retained by lightweight `components/workspace/ContractRoute.svelte` once its saved destination is admitted. Its layout already uses `DocumentBody` with `requiresDocument={false}`, so this can start before `SavedContract` imports or `runtime.hostReady` finish. Start the contract-state and selected-definition reads under that lease, overlapping frozen-content acquisition.

Move `RepWorkspace.svelte`’s `selectedV2` subscription, retained definitions, rejection reset and bounded merge into this contract-owned lifecycle. `SavedContract` retains/adopts the same editor before route-opening release. Opening-only demand must participate in initialization, view reacquisition, retention, clean-owner disposal, aggregate resume/retry and transport restart. Save-only recovery, flush and `reserveForLink()` must not acquire selected definitions or viewer data solely because they retain an editor.

Expose one reactive complete document input with pending/error/ready state, using current optimistic/draft `persistence.choices`. Resolve compatible frozen items plus retained local definitions; every required selected local choice must have its body. Preserve validation, delivered-rejection clearing, compatible retention through transient retries, the 2 MB/1,024-record bounds, required-review IDs and current-attempt protection. A contract without required locals is ready without waiting for that query; missing required wording remains pending or produces the existing unavailable-wording error.

Make this input atomic at the rendering boundary. Change `document/runtime/resources.svelte.ts` acquisition/adoption and both `RepWorkspace` paths to receive the same input before activation. Do not first overwrite a retained resource with template-only records and repair it in a later effect. Pending definitions must leave the source pending before preparation/interaction; error state must reach that same source. Preserve source/layout/selection identity checks and reuse exact prepared work only when the complete input matches.

Home background preparation receives no speculative local-definition queries. If its frozen input lacks a selected body, withhold exact preparation without spending CPU on a misleading final document; retain the downloaded snapshot for opening. The opening owner supplies complete input before that resource is admitted. Avoid treating pending input as a failed rendering attempt.

Release local view definitions with the final view/opening owner; retain only legitimate recovery/write state after detach. Keep fresh metadata/access certification for cached content. Preserve NewContract’s confirmed resource, viewer and page-element adoption, including `prepareSaved`, without duplicate compilation or pagination when inputs match.

## 5. Remove global font gating from document geometry

In `components/document/LayoutProfileSurface.svelte`, publish the surface synchronously in `onMount`. Assign a fresh mount-specific epoch containing the existing `LAYOUT_EPOCH` style/format identity. Remove global `document.fonts.ready/status` dependencies, font loading/completion/error listeners and font-only marks.

Preserve mounted checks, synchronous profiling, before/after epoch validation, stale-handle rejection and renderer/commit consistency. Unmount clears the published handle and invalidates retained handles so departed surfaces cannot populate geometry caches. Preserve style-version invalidation; do not replace font events with another readiness manager.

In `document/highlights/controller.ts`, remove font listeners, settled/awaiting-font-commit latches and font-status measurement guards together. Let actual content commits and layout epochs drive geometry. Preserve changed-page/new-epoch invalidation, delayed-commit cancellation, dirty-page queues, destroyed checks, selection ownership, content/resize observers and header projection observation. No highlight path may remain waiting for font-driven repagination.

Keep explicit document Arial/Helvetica/sans-serif, Inter UI, Newsreader widget/quotes and `CsmWidget`’s specific Newsreader wait. Add no replacement font check/load mechanism. Update related profiler/layout-context/buyer-opening comments and `docs/rendering-snappiness.md`/`docs/lifecycle.md` to describe mount/style/content readiness. Preserve general bounded opening retries.

## 6. Overlap buyer viewer code with initial status

Start the dynamic `BuyerDocumentHost` loader in `buyer/BuyerShell.svelte` alongside its initial status subscription. Share that promise/result with `BuyerContract.start()` in `buyer/contract.svelte.ts` rather than maintaining a separate late import. Keep this browser-side and dynamically split.

The shell/token lifetime owns speculative code; stale completions after replacement/destruction cannot publish. Consume speculative errors. Unavailable status remains authoritative; an admitted viewer surfaces/retries code failure through its existing opening flow.

Status still controls content acquisition, host mounting, tools and activity. Preserve reactive revocation, `setAccess(false)` cleanup, token isolation, publication subscription, bounded generations/retries and accepted-content retention on suitable retries.

## 7. Validate existing guarantees and report limits

During implementation, maintain affected existing fixtures/assertions without adding tests or expanding coverage. Do not weaken guarantees to make checks pass. Run:

- `npm run test:perf`, required for these cache/scheduling changes.
- `npm run test:lifecycle`, including SSR loading and existing Home pause/paint, template ownership, editor recovery, retained-viewer reuse, creation adoption and loading/access-recovery checks.
- `npm run build` and `npm run verify:loading-bundles`, preserving static heavy-dependency boundaries while allowing explicit dynamic warming.

Use full `npm run verify` only if the broader final gate is warranted. Report exact results and what existing assertions establish; distinguish maintained guarantees from behavior those assertions do not cover.

Reuse bounded `document/runtime/render-perf.ts` marks only where needed. Separate intent lead time from navigation; include buyer entry/status-start because the current buyer opening marker misses the initial status gap. Compare required-code/input readiness, preparation, first visible page and interaction readiness. Avoid sensitive identifiers and a new telemetry project.

The user performs browser checks for immediate/hover template and saved navigation, selected local wording, Create → saved adoption, direct/revoked buyer links and unrelated font loading. Existing mocks/jsdom do not prove real capture/navigation ordering, uninterrupted network handoff, native selection, font behavior, pixels or latency improvements. Record those limits if browser evidence is unavailable; make no measured-speedup claim.

The principal implementation risks are reservation cleanup across navigation outcomes and complete-input ownership across retained/fallback resources. The existing query shapes and client lifecycle owners support this plan; no unresolved product decision requires clarification. No tests, build, browser or deployment actions were run while preparing it.
