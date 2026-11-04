# Document projection and composition

**Historical implementation/evidence record, superseded for current backend instructions on 2026-10-30.** The [current architecture](backend-redesign/architecture.md), [17D2 local evidence](backend-redesign/phase-17d2-cross-workflow.md) and [Phase 18 activation procedure](backend-redesign/phase-18-activation.md) own present behavior/status. Older counts, formatting, indexes, attribution, probes and deployment results below describe their original revision; they do not certify the changed backend or authorize an old rollout recipe.


`PlaybookItem` is persisted business content. `toDocumentOverlay()` projects only
item identity, Triggers and concession changes. The compositor never receives
editor state or presentation copy.

A Contract Change contains a source range and an ordered structured replacement
atom array. A nonempty range replaces or deletes; a zero-length range inserts.
One concession applies all changes together. Replacements may include dynamic
numbering references. The semantic validator checks locality, source validity,
reference targets, Trigger ownership and intra-concession conflicts. Active
cross-item conflicts are blocked before requesting rendering.

## Authoring preview and saved redlines

`ContractChange` stores one source range and the complete desired replacement.
Effective view applies that replacement verbatim. Visual diff parts are derived
only for redline presentation and are never persisted.

Live `previewChanges` have no origin and use whole-range removal followed by the
complete addition on every input. Applied saved concessions carry an `origin` and
use a bounded readable diff when it clearly explains a local edit. Substantial
rewrites intentionally use whole-range replacement. That renderer also handles
unsupported or unsafe saved diffs; zero-width insertions retain their existing path.

Admin authoring previews the concession under creation or the last concession
added locally to the parent draft. The complete draft preview stays visible while
saving or resolving an uncertain result. Nested Add does not persist anything.
Acknowledgment closes the editor and clears the preview; there is no saved-redline
handoff. Cancel or starting another concession also clears this display choice.
Rep choices remain separate. The viewer receives preview changes, concession
selection and removal callbacks from its workspace.

The admin workspace omits a selected range from blue authoring highlighting only
when that same range has a preview change. Both preview inclusion and highlighting
therefore use `hasReplacementContent()` semantics, independently for primary and
secondary clauses. Clearing the wording restores selection highlighting; explain
selection is unaffected. Authoring selections remain intact in the flow state.

For ordinary text, the diff keeps words atomic and whitespace independent. A
bounded deterministic LCS proposes an alignment; readability policy decides whether
to show it. Internal equal islands are folded into both sides of an edit unless
they contain at least two Unicode letter/number words totaling eight letter/number
characters, or one word with at least ten. Exact boundary equalities are preserved.
No language-specific word list is used.

When both strings have the same nonempty sequence of substantive word runs,
only spacing or punctuation changed. Keep the original candidate and bypass weak-anchor
cleanup and retention scoring: short unchanged words must remain source, and punctuation
attached to a word must not make that word's letters count as lost. Word boundaries
still matter (`now here` and `nowhere` differ). Words remain atomic; punctuation changes
may revise the word they are attached to. Technical bounds and exact reconstruction
still apply.

For wording changes, the normalized candidate must retain at least 40% of substantive content, measured
symmetrically as twice the equal letter/number/mark/symbol count divided by the
combined count in both strings. Whitespace and punctuation cannot inflate retention.
Non-identical inputs with no substantive characters are accepted only up to 128
combined UTF-16 code units. Isolated spacing and punctuation edits retain surrounding source words.
The LCS uses at most 65,536 allocated cells; output is limited to 128 coalesced parts.
Both strings must reconstruct exactly after cleanup. Source references, generated
numbering, replacement references and budget failures use whole-range rendering.

Equal regions render through `sourceSlice()` to retain coordinates and annotation
boundaries. Inserted chunks retain offsets into the complete replacement, including
equal spans, so annotation focus can resolve after repagination. Separator and
number-label spacing rules apply in the composer, not in persisted content.
All replacement characters, including leading, trailing and whitespace-only additions,
carry added revision metadata in redline view. Synthetic separators remain undecorated.

## Source identity and selection

Baseline runs are annotated from Trigger geometry. Replacements inherit a wholly
containing Trigger. Insertions inherit one unambiguous containing Trigger,
including its boundary; ambiguous ownership is rejected. No authored ownership
override is stored. Optional paragraphs activate from ordinary nonempty insertions
at their canonical empty anchors, and numbering follows that effective structure.

Resolved runs and paginated tokens preserve source coordinates, generated offsets,
revision state and annotation memberships. Memberships identify both source triggers
and secondary concession effects. DOM annotation owners use `playbook-trigger`,
`data-item-id`, `data-annotation-id` and `data-annotation-memberships`; text spans carry
source coordinates or generated provenance. Annotation focus resolves by membership
and source/replacement offsets across pagination changes.
Source selection validates the entire DOM interval, including interior revisions.
Text inside table cells is supported. An explicit caret mode maps ordinary text
positions; an empty-slot chooser targets intentional table/optional paragraph
anchors. Single changes cannot cross source containers.

New authoring selections have a stricter policy than persisted change ownership.
Initial selections cannot intersect any existing trigger. Secondary selections
cannot intersect existing triggers or the draft's primary trigger, even when
wholly contained, and cannot conflict with the primary change. Adjacent nonempty
ranges remain valid; intentional point triggers retain their intersection rules.
New triggers also cannot split an existing concession change's ownership.

Persisted geometry still permits changes wholly contained by a trigger and
unambiguous boundary insertions. Neutral `GeometryError` failures describe `trigger-boundary`, `ambiguous-owner`
and `invalid-slot` invariants. Their detailed diagnostics stay internal; one exhaustive
translator maps them to structured selection issues for gesture eligibility and session
validation, including cached failures. This selection policy requires no schema migration and does not
reclassify existing saved records.

Initial picking uses one shared eligibility evaluation for common geometry and the
allowed authoring modes, with only concession geometry evaluated separately. Secondary
rejection precedence is invalid/cross-container source, persisted instructions, the primary
change, remaining draft Triggers, then other geometry invariants. This makes primary-change
feedback reachable while preserving every overlap restriction and half-open boundary rule.

## Verification

Run `npm run check`, `npm run build`, and `npm run format:check` from the repository
root. Check edited files separately with Prettier to distinguish patch formatting
from unrelated generated-file warnings. No additional test suite is required.

`npm run seed:verify` validates seed shape and all 48 effective/redline states
against frozen hashes, then checks token/fragment conservation and server-rendered
source attributes. The semantic hash reads original Trigger ownership from annotation
memberships; the full provenance hash also covers secondary effects and their applied state.

The reference was reconciled after the verifier's obsolete top-level ownership lookup
caused a baseline mismatch. All 24 effective and 16 unchanged redline semantic hashes
were preserved. Eight redline expectations were updated for readable diffs and spacing;
full provenance expectations now include annotation memberships and generated offsets.
Review output differences before updating expectations. Do not rewrite frozen references
merely to obtain a passing result.

Browser verification should cover selection before typing, immediate whole-range
preview, rapid typing and clearing, both affected clauses independently, explain
selection, and saved readable redlines. Also check source selection and annotation
focus after resizing or repagination. Static/build verification does not establish
input latency, scroll stability or browser highlight geometry.
