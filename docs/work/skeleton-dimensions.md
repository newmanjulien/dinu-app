Scope: Match loading placeholders to loaded element dimensions across the app; no browser checks or new tests.

Evidence: IntegrationCatalog vs IntegrationCatalogSkeleton (search, headings, summaries, action labels); ContractCard vs ContractGridSkeleton (padding, gaps, actions); SearchField vs ContractsSkeleton (35px height); Team page vs TeamRowsSkeleton (20px + 16px text lines, no gap); settings components vs SettingsSkeleton (37px buttons, 20px footer line, wrapping descriptions); IconButton vs CsmBookingSkeleton (31px controls).

Decision: Keep static styles inline. Let SkeletonBlock optionally size itself with invisible content for known text, avoiding guessed widths. Preserve approximate placeholders where content is unknown.

Completed: Inspected workspace, document, onboarding, invitation, and booking skeletons. Fixed navigation spacing and template dropdown allocation; contract search sizing and card padding/action placement; team row line heights and invitation actions; settings descriptions/footer wrapping and action dimensions; catalog row count, text, and action labels; integration details text, section count, screenshot borders, and Install dimensions; template setup text/wrapping; booking heading, description, timezone label, and navigation dimensions.

Validation: Prettier passed for changed Svelte files. `npm run check` passed, including Svelte diagnostics (zero errors/warnings) and tools TypeScript checks. No tests added/run and no browser checks. Saving/scheduling/caching behavior is unchanged; booking changes only affect placeholder markup.

Limits: Unknown record text/counts and installation/ownership-dependent actions remain approximate until data arrives. Browser appearance and responsive transitions are unverified. Document paper geometry and onboarding/invitation frames already match their structural counterparts; no speculative changes there.
