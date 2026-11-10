# Independent buyer template instructions

Approved behavior: shared source and frozen template version; independent rep/buyer highlights and wording; buyer starts empty; no rep fallback. Template text opens /template; caret offers Rep and Buyers (/template/buyers). Buyer editor has Explanation only and can copy the entire saved rep Summary when the selection is wholly contained in one rep trigger. Rep blue, buyer green. Preserve current visible-text annotation mapping through concessions.

Implementation in progress. Reuse compact heads, revisions, manifests, session/transport, bounded preloading and save acknowledgements. Keep contract negotiation types rep-only and buyer annotations separate from composition geometry. Audience cannot change for an existing item.

Validation required: maintain affected existing performance assertions, npm run test:perf, npm run build (includes type checks). No new tests, browser checks or deployment. Existing checkout has extensive unrelated changes; do not reset.

Evidence: src/convex/playbookItems.ts, templates.ts, contractReader.ts; src/lib/playbook/template-authoring-session.svelte.ts; TemplateWorkspace.svelte; BuyerDocument.svelte.

Completed: audience bodies and compact codec, partitioned validation, shared save/session adapters, frozen snapshot and cache admission, rep-only contract consumers, buyer public projection/activity, template routes/menu, buyer authoring and saved Summary copy, audience colors/help. Retained viewer resource handling now recognizes both template audiences.

Verification: first npm run test:perf passed all 37 existing tests across 7 files. Application type checks pass without warnings. Build found tooling type assumptions about rep-only heads; targeted corrections made. Final formatting/build and existing authoring lifecycle checks remain. No browser or deployment performed.

Final verification: npm run test:perf passed 37/37 existing tests (7 files). Existing authoring/session/loading lifecycle checks passed 18/18 across the selected 3 files; the cold-panel file was rerun after restoring its accessible skeleton and Close action, retaining cancellation/late-response assertions and updating its document selector to Template editor. No new tests were added. Final npm run build passed application checks (0 errors, 0 warnings), tooling TypeScript checks and client/server production builds. git diff --check passed for affected paths.

Automated guarantees checked: existing saving/idempotency/revision and capture bounds, caching/creation/preloading constraints, authoring acknowledgement/recovery and cold-panel cancellation behavior. Buyer-specific UI, copy eligibility, colors/help, cross-audience overlap and concession highlight mapping remain manually unverified; no browser or deployment command was used. Implementation complete.
