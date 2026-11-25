# Document formatting and paragraph roles

Canonical text blocks are paragraphs with a required `role: 'title' | 'heading' |
'body'`. Tables remain separate. There is no persisted heading block kind or
heading level. Anchors and legal numbering are independent of role; existing
anchors, block keys, source keys, and reference targets survive conversion.
The opening title is one contiguous unnumbered group. The viewer and Word export
render that group at H1 and every other heading at H2.

`src/lib/document/format.ts` owns Arial, regular weight throughout, 15px body text,
17px headings, 18px titles, 24px body/heading line height, and 23px title line height.
Normal paragraphs have 14px between them. Headings have 21px above and 7px below;
consecutive headings have 7px between them. Visible title lines have 4px between
them, and the title group adds 4px to its following gap. A boundary receives one
gap, before its following block. Screen measurement and Word export share this
policy. Empty space/tab paragraphs allocate no extra gap but retain their source
anchors; explicit source line breaks retain their lines and offsets.

Notice groups opened by `If to ...:` keep short contact/address lines together
without additional gaps. This is a layout hint, not a heading classification.
Heading and title keep-with-next behavior consumes stored paragraph roles;
layout does not guess headings from wording or numbering.

## Automatic recognition

DOCX parser `docx-11` resolves legal numbering and references before classifying
paragraphs. Effective run formatting is collected before adjacent text runs are
merged. The analyzer uses heading styles at any Word level, title styles,
formatting over label words, document-relative font/emphasis, wording, and context.
Numbering, whitespace, and punctuation do not dilute emphasis across label words.
Source bold/italic/underline are evidence only and never rendered formatting.

The analyzer distinguishes standalone labels from run-in labels and prose.
Signature, contact, and form fields remain body text. Attachment labels can be
headings but cannot extend the opening title. Capitalization, size, or centering
alone is insufficient. Decisions have a short reason and an uncertainty flag used
by the analyzer and operator diagnostics. They are deterministic classifications,
not a guarantee of author intent. Short, strongly emphasized labels that conflict
with prose evidence remain body text with an uncertainty flag, including labels
containing auxiliary words such as “is”.
Formatting evidence is retained only for top-level paragraphs; cell runs still
receive all formatting and structure checks.

A pending upload has immutable automatically classified blocks, a parse
fingerprint, and conversion diagnostics. Reuploading the same file and parser
generation by the same uploader reuses the current pending source without extending
its expiry. A successful upload becomes company-owned pending data retained for
90 days from upload, including after the uploader leaves. The customer waits for
Julien; upload success does not unlock the editor. Analysis decisions are not
persisted on the source.

Trusted release binds the exact company, current pending source and fingerprint,
validates canonical blocks and accounting, preserves roles and chunks, and creates
the first template version atomically. Identical release retries return that
version; expired or replaced pending uploads are rejected. Release does not require
the original uploader. The pending source owns its original file until release or
reference-safe cleanup. See [assisted template setup](assisted-template-setup.md)
for booking requirements and privileged inspection/release commands. Existing active
templateSources retain their canonical roles, including earlier manual corrections.

## Editing and Word output

Text replacements retain their paragraph role. Additional split or inserted
paragraphs default to body, with title inheritance only inside the existing
opening title group. Same-role merges retain that role; mixed-role merges become
body. Clause-number inheritance is separate. Numbered headings retain their role
through composition. The optional `numbering.continueSequence: false` marks a
section number that cannot be inherited by inserted/split body paragraphs. This
editing policy is independent of presentation roles. Every non-table paragraph boundary is eligible for structural
editing, including boundaries between headings.

Word headings use styles based on Heading 2 and titles use a style based on Heading 1.
Canonical `ContractBody`/`ContractHeading` and numbered styles retain accepted
paragraph roles explicitly, so their classification survives Word export
and reimport. Ordinary Word heading styles remain analysis hints. A canonical
title moved outside the opening group becomes a heading flagged for operator
inspection. Numbered paragraph styles `ContractClause1` through `ContractClause9`,
their section variants,
and their `ContractHeadingClause`/`ContractHeadingSection` counterparts retain legal
depth and continuation policy independently of outline levels and visible labels. A versioned canonical numbering part preserves complete counter/sequence/parent
semantics and validates those depths and visible labels on reimport; numbered
legacy exports lacking that metadata require a fresh export. Heading classification never resets clause
inference; explicit exhibit/schedule/appendix labels establish numbering scopes.

`ContractTableGap` is a private empty layout artifact removed before source keys
are assigned on reimport. `ContractEmptyBlock` preserves real empty paragraphs.
Empty title anchors and interaction placeholders allocate no exported paragraph.

All text roles share the same token intervals, observed line geometry and page
splitting. Short titles/headings stay with following content when the group fits
an empty page; impossible groups relax that preference and oversized text splits
at observed line boundaries. Continuations allocate no leading gap. Every source
anchor renders once on its first live fragment, including after a role demotion;
profile surfaces and continuation fragments suppress IDs. Structural boundaries
belong only to the final fragment. Layout epoch 10 invalidates earlier geometry.

Structural title membership is reconciled after merges, transfers and insertions.
Only the surviving opening prefix retains title roles; removed redline sources
do not determine that prefix.

## Strict paragraph-role schema

The strict schema stores canonical `role: 'title' | 'heading' | 'body'` paragraphs directly on all `templateSources` chunks. The one-off `templateSourceFormatting` backend module and legacy role-transition scripts (`scripts/template-source-roles.mjs`, `scripts/paragraph-role-transition.mjs`) are removed.

## Verification

Run `npm run test:perf`, `npm run seed:verify`, and `npm run build` for this model
change. The reference refresh's explicit `--paragraph-roles` mode first checks the
old representation and full provenance against frozen hashes, accounting for the
retired heading levels, explicit numbering metadata, and newly available
heading-to-heading insertion edges.
It then writes hashes for the canonical representation; normal verification
retains its strict assertions.

Local importer/exporter diagnostics on the supplied Oceans DOCX establish 21
non-title headings, 84 unchanged clause addresses, unchanged source content and
identities, and a successful Word roundtrip. The former upload-review diagnostics
do not verify the simplified acceptance path. Local type/build checks and the
performance suite do not directly establish upload ownership, expiry, reuse,
concurrent/idempotent acceptance, or the UI handoff. Browser geometry, Word
application appearance, native backend concurrency/resource boundaries, and
recognition accuracy across other documents require separate verification.

## Retiring upload-review metadata

The strict template source schema no longer admits `review` on prepared/deleting DOCX
records or `acceptedReviewRevision` on active DOCX records. Before deploying it to
an existing target, inventory template source metadata for those fields. If none exist,
no data cleanup is needed.

If either field exists, stop application activity and old writers for the release.
Temporarily retain the former optional field validators while deploying a scoped
internal cleanup. Process bounded, cursor-based pages of template source metadata;
remove only `review` and `acceptedReviewRevision`, and make each page safe to
retry. Do not change canonical chunks, roles, fingerprints, IDs, version manifests,
byte totals, original files, or timestamps. Verify the fields are absent across
all pages before restoring the strict validators and deleting the temporary helper.
Release the new frontend and backend together, then reload clients before resuming
activity. Requests carrying the obsolete review revision must fail validation.
Unaccepted draft corrections are discarded; active corrections already stored in
canonical chunks are preserved. This removal needs no parser/cache version bump.

## Development rollout, 2026-11-05

The source-matched Oceans DOCX template source on the former development deployment
was repaired and strict schema validation restored. Its
248 blocks now include 21 non-title headings. All 84 clause addresses, source
identities/content, chunk IDs, original-file metadata, and template identity/manifest
were preserved. Native chunk bytes and the existing template's accounting were
verified after repair. Reanalyzing the retained original on the backend reproduced
the accepted role map. Private before/after records and the reversible manifest
were retained outside the repository. Production was not changed.
