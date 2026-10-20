# DOCX baseline import

Import runs locally in a disposable worker. It uses Word's document structure and
formatting rules, without an LLM. The result uses the same immutable source model,
composition, reference resolution, and Word export as existing contracts.
Errors block publication. The upload page gives plain-English corrections and
short text excerpts to find in Word, without displaying the contract. Routine
layout warnings remain in the conversion diagnostics; the page explains once
that Agreed applies its own layout and ignores comments and footers. A valid
file can be published after confirming that the starting contract is permanent.

## Supported content

- Paragraphs, Heading 1–3, bold and italic text, explicit formatting overrides,
  tabs, line breaks, and rectangular tables with multiple paragraphs per cell.
- Document defaults and inherited paragraph, character, and table styles. Table
  text supports whole-table, first/last column, and first/last row conditions.
  Row conditions take precedence over column conditions.
- Decimal, upper/lower letter, and upper/lower Roman automatic numbering, up to
  nine levels, including starting values, decimal-zero padding, literal prefixes
  such as `Article`, supported label patterns, and restarts. Automatic letter
  numbering follows Word after z: aa, bb, …, zz, aaa.
- Unambiguous typed clause labels under the inference rules below.
- Typed Article/Part/Clause/Section references, including groups joined by commas,
  conjunctions, and ranges, and supported Word REF fields. Every target in a typed
  group must resolve uniquely. References retain their spelling, punctuation,
  bold/italic formatting, and stable numbering item keys as numbering changes.
- Declared `customXml` wrappers preserve supported paragraphs and tables.
  Hyperlinks preserve their text with a warning. Leading/trailing omitted table
  columns become empty cells, preserving the position of occupied columns.
  Right-to-left tables are normalized to visual left-to-right column order after
  applying their formatting in Word's logical column order.

Fonts, spacing, colors, borders, underline, page/column breaks, and hyperlink
behavior use Agreed's layout. Comments, comment anchors, and footers are ignored,
including their related parts. They do not become contract text or publication
errors. Blank headers and validated PAGE/NUMPAGES fields are discarded;
substantive headers must move into the body. Archive expansion bounds still
include ignored parts.
Related parts are located through package relationships, regardless of filenames
or extensions. Only the main document, styles, numbering, and headers are retained
for XML parsing; ignored payloads are counted while inflating and discarded.
Consumed XML parts support UTF-8 and UTF-16 in either byte order.

## Content that requires correction in Word

Unknown content is rejected rather than flattened into text. This includes math,
drawings, text boxes, tracked content or formatting changes, content controls,
unsupported fields, nested tables, merged cells, and numbered lists in cells.
Effective hidden, struck-through, superscript/subscript, or unsupported
complex-script formatting is rejected, including when inherited from defaults or
styles or selected by the run's text without explicit `cs`/`rtl` properties.
Table band/corner run formatting, explicit conditional row/cell overrides,
and table-style numbering require direct formatting or removal in Word.

Bookmarks must open and close within one paragraph. A numbered REF requires a
bookmark covering the whole clause, its exact typed label, or an empty bookmark
at an automatically numbered paragraph's start. Its cached result must identify
the resolved full address; supported differences in case, padding, and punctuation
are preserved. Authored literal words and digits remain literal, including a
Word pattern such as `%1:2.`; only its counter changes when clauses renumber.
Accepted fields own their complete cached display span within a typed group.
An independently valid field remains live when another typed target in that group
needs correction; unsupported field/range overlaps still block publication.
Supported REF switches are `\w`, `\n`, `\h`, and
`\* MERGEFORMAT`; `\n` is limited to root clauses. An ordinary REF without a
number switch only supports an exact typed-label bookmark. Nested or malformed
fields, ambiguous targets, and mixed formatting within a reference are rejected.

## Typed numbering inference

Inference deliberately recognizes a bounded grammar. Word's counters produce
automatic labels, then automatic and typed candidates share one hierarchy pass.
An independent level-zero Word list can be a child of the active typed or
automatic section. Unnumbered headings reset the numbering inference boundary.
Exhibit/Schedule/Appendix titles also establish a distinct reference scope;
ordinary headings within an attachment retain its reference scope. Numbered
headings, tables, and ordinary intervening paragraphs retain both boundaries.

- Decimal labels include `1.`, `1)`, `1.2`, and padded values such as `01.`.
  Letters and Roman numerals support parentheses, brackets, periods, and closing
  parentheses. Literal `Article`, `Section`, `Clause`, and `Part` prefixes are
  supported.
- Root sequences need at least two increasing siblings, except explicitly
  prefixed labels such as `Article I`. Sequences may skip values; restarts create
  separate sequences. Duplicate addresses still block references to them.
- Local children require a confirmed preceding parent. A singleton local child
  must start at one; a full typed address may identify a non-one child explicitly.
- Full typed addresses must name an active preceding parent. Word ancestors,
  effective label indentation, and returning to a prior label convention establish
  hierarchy without a fixed order of decimal, letter, and Roman styles.
- Roman/letter ambiguity is resolved using indexed neighboring candidates in the
  same inference boundary and label convention, including across intervening
  nested clauses. Decimal, Roman, repeated-letter, and sequential-letter token
  interpretation share the same 1–10,000 counter bound.
  Obvious decimal labels and connected references outside that bound remain
  ordinary text with a correction; valid subsets of a typed group are not linked.
- Typed lettering can use Word's repeated-letter convention or sequential
  lettering such as z, aa, ab, ac. A sequence with mixed letters identifies the
  latter. Decimal padding is retained consistently across a sequence.
- Cached Word field results are excluded from typed-prefix inference.
- Every accepted label must reproduce Word's displayed label exactly.

Typed references resolve in the current scope, with full agreement addresses
available from attachments. Explicit qualifiers such as `of the Agreement` or
`of Exhibit A` select that scope; duplicate or missing targets block publication.
Connected groups are parsed in full before scope selection or target lookup.
They retain parenthesized section titles, repeated Section/Clause prefixes,
abbreviated child labels, and supported ranges. Closing prose parentheses end the group, so a following
prose-list marker does not become a reference. Conversion must reproduce each
reference's original spelling and punctuation, including case and padding.
Exact-case targets take precedence; a case-insensitive match is accepted only
when unique. For example, `Section 8(C)` can link to `8(c)` while retaining `8(C)`.
Parenthesized titles such as `(Fees)` remain prose, rather than additional clause
levels. Unresolved references remain ordinary source text with a correction error.

Unsupported or ambiguous labels remain visible in the conversion result and
produce an error. The upload result gives each error a short text excerpt to find
in Word, or its location when no excerpt is available. Missing-reference errors
show available sibling clauses when possible;
ambiguous-reference errors request a fuller address or scope qualifier. Users
correct the original file in Word and re-upload; the app does not edit it or
choose an intended target for a missing clause.

## Processing and persistence

The pipeline is package extraction → bounded namespace-aware XML parse →
paragraph/run/field/bookmark/table model → numbering resolution → ordered reference
replacement → source atom emission → shared source/storage validation. Foreign
XML namespaces remain distinct, with separate namespace rules for Word, package
relationships, and content types. Each consumed part is parsed once; the raw bytes
are then released. Paragraphs receive unique identities before formatting or
diagnostics, including separate paragraphs within the same table cell. Simple
and complex fields have explicit instruction/result states. Style inheritance
uses cycle detection and a depth check that remains valid when ancestors are
cached; character styles apply to both body runs and numbering labels. Styles and
resolved table conditions are cached. Reference replacement sweeps runs and field
spans in order instead of rescanning every run for every field. Typed-label
formatting scans stop at the end of the label; signature
text is collected only for eligible two-column borderless tables. The shared
source index owns block-order validation. Stable source keys are assigned after
conversion. Diagnostic retention is capped independently at 100 warnings and
500 errors; warning volume never makes an otherwise valid import fail.

Numbering and reference display patterns use explicit literal and counter parts
across import, composition, validation, and export. Word's raw `%1`–`%9` syntax is
interpreted separately, so a literal colon or digit after a counter remains
literal. Existing persisted string patterns and legacy abbreviated-reference
metadata remain readable; new imports emit explicit parts.
New letter imports explicitly store either repeated or sequential lettering.
Persisted numbering without this metadata retains sequential lettering, including
z, aa, ab, so existing contracts keep their labels.

Vite prebundles the upload worker's `fflate` and `saxes` dependencies. This avoids
discovering them during the first upload and sending a full reload that clears
the component's local file and result state. Uploads remain local and disposable;
refreshing intentionally clears them.
Publication navigation belongs to the route intent and session that started it.
A newer navigation or changed session prevents a late publication response from
redirecting the user. The expected same-route setup unmount after publication
still allows navigation to the admin page.

The server independently validates the submitted baseline. Only an authenticated
company admin can initialize an empty company. Publication captures validated
content once, reserves transaction capacity, writes live and immutable version
records, and exposes the version through one pointer write in the same mutation.
The baseline cannot be replaced. An identical retry uses a canonical fingerprint
and returns the current published version. Later playbook publications use the
same captured-snapshot path without rereading live content.

## Bounds

| Boundary                                          | Limit                        |
| ------------------------------------------------- | ---------------------------- |
| Uploaded archive                                  | 10 MiB                       |
| Actual expanded archive / entries                 | 50 MiB / 2,000               |
| Individual retained XML part                      | 12 MiB                       |
| Parsed XML nodes / depth / attributes per element | 300,000 / 100 / 100          |
| Parsed XML characters across consumed parts       | 12 million                   |
| Imported blocks / serialized baseline             | 400 / 512 KiB                |
| Paragraphs / text segments / text characters      | 20,000 / 100,000 / 1 million |
| Characters per paragraph                          | 512,000                      |
| Fields / instruction characters                   | 10,000 / 4,096               |
| Table columns / rows / total cells                | 256 / 8,192 / 20,000         |
| Persisted array entries / content nesting depth   | 8,192 / 32                   |
| Individual source block / playbook item JSON      | 900,000 / 500,000 bytes      |
| Worker duration                                   | 30 seconds                   |

Archive expansion is counted while inflating, and XML budgets are enforced while
parsing, before building the normalized tree. Browser and server validation share
storage array limits; source and playbook item limits leave room for Convex wrappers.

## Verification evidence

Fresh local checks on 2026-10-20 covered all eight accepted review findings:
legacy and explicit lettering, typed inference, repeated-prefix/title ranges,
Word REF literal words/digits, case/padding and renumbering, whole-group counter
bounds, namespace cleanup, and one native list formatter per import needing
sibling alternatives. The 36 focused conversion checks passed. Compatibility
probes also passed for legacy string patterns and suffixLevels, scope qualifiers,
abbreviated references, malformed fields, distinct table-paragraph diagnostics,
foreign namespaces, cached style-depth bounds, warning saturation, ignored-part
expansion bounds, Word lettering starting at 27, and Roman numbering near 10,000.

The uploaded `Oceans PSA Contracting Cheat Sheet 9.21.26 (2).docx` imports 249
blocks, 84 numbered clauses, and 31 live reference atoms. Exact parsed-body parity
covers 44,775 characters, bold/italic marks, and positions of all 12 table cells.
Its 67 layout warnings stay out of the user-facing correction list. One source
reference remains blocked: `Section 3(a)(iv)` has no matching clause; the correction
lists `3(a)(i)`, `3(a)(ii)`, and `3(a)(iii)` as existing siblings. `Section 8(C)`
resolves to `8(c)` while preserving its original spelling. Export and reimport
retain 117 nonblank blocks, all 84 labels, 31 references, that same source error,
and exact composed text, formatting, and table-cell positions.

Exact upload-script probes passed for read/worker replacement, stale callbacks,
destruction during reading, timeout, read rejection, and successful worker
cleanup. Nine publication probes used the actual component script and Workspace
navigation callback: mounted and expected same-route unmount success navigate;
changed route intent, committed route, user, session preparation, transport
generation, closing state, or membership prevents stale navigation. These checks
exercise control flow without browser event dispatch or the Svelte DOM.

A fresh cold Vite probe loaded 24 modules, confirmed prebundled `fflate` and
`saxes`, and observed an unchanged dependency hash and zero full reloads.
Numbering at 32/128/384 clauses took local medians of 1.94/5.68/10.72 ms.
Mixed field/typed groups at 64/256/1,024/4,096 repetitions preserved
128/512/2,048/8,192 references; the largest inputs correctly report the independent
512 KiB baseline and 8,192-entry array bounds. Local timings are observations,
not latency guarantees.

`npm run verify` passed all 24 existing performance checks in five files, then
type checking with zero errors/warnings and the production build. The suite
checks saving, scheduling, caching, and publication rollback guarantees.
No assertions were weakened and no repository tests or browser harness were added.

Earlier implementation checks, recorded before this review, imported the exported
built-in contract with 112 blocks and 84 labels and verified repeated export/import
parity after applying Word heading/table styles. Those built-in checks are
historical evidence, separate from the fresh checks above.
Browser upload/cancellation, visual pagination, arbitrary third-party Word
formats, and live multi-admin races remain unverified. No deployment was performed.
