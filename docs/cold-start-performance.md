# Cold-start implementation and evidence

**Historical implementation/evidence record, superseded for current backend instructions on 2026-10-30.** The [current architecture](backend-redesign/architecture.md), [17D2 local evidence](backend-redesign/phase-17d2-cross-workflow.md) and [Phase 18 activation procedure](backend-redesign/phase-18-activation.md) own present behavior/status. Older counts, formatting, indexes, attribution, probes and deployment results below describe their original revision; they do not certify the changed backend or authorize an old rollout recipe.


## Status

This report records the earlier performance refactor. The subsequent
[domain implementation report](document-domain-runtime.md) supersedes its source
acceptance, semantic ownership, search, and startup-counter descriptions; historical
measurements below are unchanged and are not new-refactor browser evidence.

This implements the measurement-supported startup cleanup, persistent browser
profiling host, and an opt-in reduction in hidden profiling DOM overhead from the
supplied execution plan. **The complete plan’s production performance acceptance
criteria have not been met or verified.** No partial `RenderSnapshot`, early-page
preview, virtualized document, worker, or persistent disk cache was introduced.

The live Convex endpoint failed DNS resolution (`EAI_AGAIN`) in this execution
environment. Browser comparisons therefore used a temporary seed-backed build
of the actual production components, with backend writes disabled. That fixture,
its query override, and all inspection hooks are absent from the delivered source.
The real parallel Convex loader and authoring save transport are unchanged.

## Delivered changes

1. The initial query result is accepted synchronously once. Its first reactive
   replay is skipped only if all four data/error references still match. Later
   updates always enter the ordinary acceptance path; updates or errors arriving
   before the first effect are observed, and selection reconciliation still runs.
2. Baseline and overlay equality remain exact serialized comparisons. Comparing
   ordered per-overlay keys and the already-canonical baseline removes the second
   serialization of the entire render projection. No hash or backend version is
   substituted for exact equality. Item ordering and duplicate IDs do not weaken
   that equality check. Instructions-only updates keep the render revision.
3. The app layout owns one profiling surface and profiler across Rep/Admin
   navigation. Renderers, complete snapshots, search, selection, errors, and view
   intent remain route-local. Existing mount/font epochs, foreground/idle queue
   priority, stale-result checks, and cache insertion validation are unchanged.
4. With `PUBLIC_CONTRACT_PROFILE_METADATA=0`, hidden profile token leaves omit
   interaction/provenance attributes that no
   profiling reader or CSS selector uses. Their span/text structure, token marker,
   annotation wrappers, revision wrappers, and browser geometry reads are unchanged.
   Visible leaves keep all original source/provenance attributes. Production
   `BlockFragment`, `InlineContent`, `RevisionText`, and `SourceText` still render
   both surfaces; no separate hand-built measurement DOM was introduced. Full hidden
   metadata remains the default until the production performance gates are met.
5. Opt-in bounded startup work counters and readiness events distinguish source
   duplication, indexing, validation, mounts, epochs, interactions, and search.

Source indexing/validation were small in the local measurements (approximately
1–2 ms combined in an inspected cold run), while composition plus preparation
medians were about 12–13 ms. A shared baseline artifact, new server identities,
and a persistent semantic engine were therefore not added. The dominant measured
render phase was browser profiling (cold median approximately 149–155 ms), followed
by visible DOM commit. This is an intentional use of the plan’s stop/skip gates.

## Ownership, identity, invalidation, and eviction

The persistent context contains only a live profiling surface and its profiler.
It is scoped to one app layout, never a module-global cache or a shared SSR session.
A font cycle invalidates the surface and creates a fresh profiler/epoch on readiness;
app unmount invalidates the old surface handle. Geometry remains keyed by the
existing layout-affecting fingerprint and live epoch. It carries no stale content
or provenance; current prepared objects are associated on every request.

The existing cache retains all current-document profiles plus a bounded LRU of
256 optional shapes. Current shapes are protected from optional warming pressure.
No new accumulating document/version cache was added. Each workspace owns its
acceptance closure; its initial replay snapshot is released at the first source effect.
Snapshots start empty in a new route, so Rep concessions and Admin previews cannot
be displayed as destination content while a new view renders. Same-view warm
failure/cancellation behavior is unchanged.

## Recorded local measurements

Environment: production Vite preview, headless Chromium 133 on Linux, viewport
1440 × 1000, device scale 1, repository seed (113 blocks, 56 items, 21 concessions),
no CPU throttle, browser resource cache disabled for the repeated navigation runs.
There were 20 cold samples per role and 20 transitions in each direction for each
of baseline, startup/host changes, and the hidden-metadata candidate. Percentiles
used nearest rank. The first iteration also captured a browser timeline.

These are **exploratory fixture measurements, not production latency evidence**.
Some baseline samples overlapped diagnostic/build activity; earlier preview
processes also accumulated memory before the focused comparisons were isolated.
Visible DOM timings had large multi-second outliers. Do not use these runs to
certify a p95 regression budget, and do not equate a paint opportunity with physical
presentation. Re-run a controlled full matrix on the deployment before further
architectural decisions.

| Work count                                   | Baseline | Updated |
| -------------------------------------------- | -------: | ------: |
| Source acceptances per mount                 |        2 |       1 |
| Baseline serializations per mount            |        2 |       1 |
| Overlay projections/serializations per mount | 112 each | 56 each |
| Whole-projection serializations per mount    |        2 |       0 |
| Same-geometry route profile misses           |      113 |       0 |
| Same-geometry route profile batches          |        1 |       0 |
| Same-geometry route profile hits             |        0 |     113 |

The zero-batch route result held across all 40 observed transitions.

Recorded timings in milliseconds (p50 / p90 / p95). The updated column includes the
hidden metadata reduction, which is now opt-in; these are not measurements of the
current default configuration:

| Scenario / metric                       | Baseline                 | Updated, including hidden metadata reduction |
| --------------------------------------- | ------------------------ | -------------------------------------------- |
| Cold Rep: request → snapshot            | 164.5 / 178.6 / 243.2    | 139.0 / 164.3 / 165.8                        |
| Cold Admin: request → snapshot          | 171.2 / 191.5 / 199.1    | 137.4 / 155.2 / 157.1                        |
| Cold Rep: profile resolution            | 149.2 / 160.4 / 226.9    | 125.0 / 146.0 / 151.2                        |
| Cold Admin: profile resolution          | 154.6 / 177.0 / 180.5    | 120.5 / 138.0 / 138.6                        |
| Cold Rep: request → paint opportunity   | 358.3 / 386.5 / 557.3    | 346.4 / 387.3 / 395.1                        |
| Cold Admin: request → paint opportunity | 368.8 / 416.7 / 429.0    | 338.6 / 378.7 / 384.9                        |
| Admin → Rep: request → snapshot         | 5346.3 / 5464.4 / 5466.3 | 11.2 / 13.3 / 17.4                           |
| Rep → Admin: request → snapshot         | 683.9 / 5406.1 / 5546.0  | 10.6 / 12.4 / 13.2                           |

Do not infer equally large end-to-end navigation gains from snapshot timings:
updated route paint-opportunity p95 remained approximately 6.3 seconds in these
noisy runs, dominated by visible DOM work. Cold paint-opportunity p50 improved much
less than snapshot assignment and does **not** establish the plan’s 60% target.

## Correctness observations and final checks

Before the workspace reset, focused browser inspection compared full-metadata and
reduced-metadata paths using the actual seed. All 23 page-layout and visible
source/provenance signatures matched: baseline, all 21 saved alternatives, and
one whole-range authoring preview. Each alternative was applied/removed and applied
again; all 21 repeats were cache-only. Removing each alternative restored baseline
layout/provenance. Baseline page text/boundaries also matched across all repeated
route runs.

The same inspection observed: query failure retention and recovery; rejection of
an invalid index while retaining source; unchanged render revision for metadata-only
updates; technical failure retention and retry; font-epoch invalidation followed by
113 fresh profiles; search results; native selection; Trigger panel activation;
Rep selection isolation from Admin; Admin preview isolation from Rep; and route
cache reuse. No browser page errors were reported. This exercised the renderer’s
preview path, not a backend authoring-save round trip.

A focused source inspection also confirmed initial replay suppression, equal-clone
revision stability, updates/errors before the first effect, ordered-key equality,
and distinct viewer-indexability versus authoring-validation policies.

**Evidence retention:** the temporary workspace reset during a user pause before
saving. Raw samples, traces, and inspection scripts were lost. The figures and
observations above were retained in the conversation’s tool outputs; they are
reported as such, not presented as archived raw evidence. The final source was
restored from the recorded edits. Final type/build/seed/format command logs are
included under `docs/performance/`; browser measurements were not repeated after
that restoration. The post-review focused checks are recorded in `docs/performance/review-fixes.log`.
No test framework or new test suite was added.

Untouched baseline: type checking and production build passed. `seed:verify`
passed all 48 effective/redline semantic and provenance states, despite an HMR
socket permission warning in the sandbox. The previously documented frozen seed
mismatch did not reproduce. Repository formatting reported nine existing files:
eight Convex generated/configuration files and `help-content.ts`. Those unrelated
files and frozen references are unchanged.

Final post-review results:

| Check                                      | Result                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `npm run build` (includes `npm run check`) | Passed; 0 Svelte errors / warnings                                                              |
| `npm run seed:verify`                      | Passed all 48 parity states; nonfatal sandbox HMR socket warning                                |
| Focused review checks                      | Passed: in-place updates, replay suppression, early updates/errors, recovery and counter shapes |
| Changed-source Prettier check              | Passed, all changed/new source files                                                            |
| `npm run format:check`                     | Same nine pre-existing failures; no new failures                                                |

## Review corrections

- Source publication now compares the accepted index, not the caller's block-array
  identity. In-place baseline changes advance the render revision and publish the new index.
- Reduced hidden metadata is opt-in pending the outstanding production acceptance gates.
- The shared validator again has a single blocks argument; authoring times its complete
  validation operation without a telemetry-only index factory.
- Initial and reactive acceptance share a workspace-owned method. No module-level
  acceptance registry is retained.
- Startup counters distinguish count-only events from timed work; unused metric
  categories and empty callback timing were removed.

The persistent layout-owned geometry host remains appropriate: it retains geometry
within a live font/layout epoch while semantic state and snapshots stay route-local.
No shared semantic cache or broader renderer rewrite is justified by the available evidence.

## Rollback and measurement instructions

- `PUBLIC_CONTRACT_ROUTE_PROFILES=0`: restore viewer-owned profiling surfaces and
  fresh route caches without changing snapshots or semantic rendering.
- `PUBLIC_CONTRACT_PROFILE_METADATA=0`: opt into reduced source metadata on hidden
  profiling leaves. Unset or `1` keeps full metadata (the default). Visible metadata
  is present in both modes.
- `PUBLIC_CONTRACT_PERF=1`: enable diagnostics in production. Development already
  enables them. See `rendering-snappiness.md` for the fields and counter semantics.
- Startup cleanup is isolated in `runtime/workspace-context.ts`,
  `runtime/workspace-factory.ts`, and `runtime/source.svelte.ts`. Their diff in
  `IMPLEMENTATION.patch` is an independent rollback boundary.

Build and start a production preview with the desired environment flags. Use the
real authenticated source and a fixed browser, fonts, viewport, CPU/network profile,
and seed/version. Collect at least 20 repeated samples per matrix row, preferably
more for p95. Capture browser traces for cold Rep and cold Admin. Take deltas of
`__contractStartupPerf`, and retain `__contractColdStart` / `__contractRenderPerf`
with each trace. Keep source transport, snapshot assignment, DOM commit, search,
authoring readiness, and trace-confirmed paint separate.

## Remaining execution-plan gates

The full live baseline/after matrix is outstanding: actual navigation/network,
warm reload, controlled CPU/network throttling, representative long-paragraph and
table-heavy fixtures, and repeated production authoring readiness. Physical paint
and deployment p50/p90/p95 budgets remain unpopulated. Apply the plan’s 60% cold
p50 / 70% cold p95 ratios and ≤5% warm/authoring p95 regression guardrails to those
controlled baselines, not to the exploratory numbers above.

The work is therefore ready for code review, **not a declaration that the full
cold-start objective is complete**. The next decision requires deployment traces
of the remaining visible DOM/bootstrap cost. Do not automatically add partial-page
rendering, virtualization, disk geometry, or workers to finish a roadmap.
