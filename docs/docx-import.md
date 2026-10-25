# DOCX baseline import

Import runs on the backend from the uploaded original DOCX. It uses Word's document
structure and formatting rules, without an LLM. The result uses the same immutable source model,
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
  Repeated style IDs are accepted only when their complete parsed definitions
  match, regardless of XML attribute order; the first definition is retained.
  Missing style IDs and conflicting definitions require correction.
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
errors. Paragraph-level content controls containing only comment markers are also
ignored in the body and headers when their only properties are `id` and `tag`
metadata. Blank headers and validated PAGE/NUMPAGES fields are discarded;
substantive headers must move into the body. Archive expansion bounds still
include ignored parts.
Related parts are located through package relationships, regardless of filenames
or extensions. Only the main document, styles, numbering, and headers are retained
for XML parsing; ignored payloads are counted while inflating and discarded.
Consumed XML parts support UTF-8 and UTF-16 in either byte order.

## Content that requires correction in Word

Unknown content is rejected rather than flattened into text. This includes math,
drawings, text boxes, tracked content or formatting changes, substantive or
malformed content controls (including unsupported control properties),
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
cached; character styles apply to both body runs and numbering labels. Duplicate
numbering IDs and package metadata keys remain invalid. Styles and
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
literal. Persisted label patterns and reference display patterns are required
structured arrays. Alphabetic numbering explicitly stores repeated or sequential
lettering. The offline seed generator emits the same canonical format, preserving
its sequential z, aa, ab labels.

The existing upload page sends the original DOCX to the authenticated Convex HTTP
endpoint `POST /baseline`, with a company membership and filename. The backend
checks admin access and that the company has no permanent baseline, bounds the
request body, and runs the parser. Error diagnostics return without persisting
an upload. A document with no meaningful contract text also requires correction.
A successful check stores a prepared baseline and its blocks, the original file,
SHA-256 file hash, canonical content fingerprint, parser version, uploader,
filename, and diagnostics. The browser receives the prepared baseline ID and
diagnostics; no public mutation accepts client-generated baseline blocks.

The page retains the same checking, correction, confirmation, and Publish flow.
The request has a 30-second deadline, including token retrieval and response-body
reading. Choosing another file or leaving the page cancels the attempt. Changed
sessions and memberships prevent stale results from becoming publishable.
Publication navigation belongs to the route intent and session that started it.
A newer navigation or changed session prevents a late publication response from
redirecting the user. The expected same-route setup unmount after publication
still allows navigation to the admin page.

Publication accepts the prepared ID, verifies its company, uploader, validity,
and fingerprint, and atomically marks the baseline published, creates the first
version, and updates the current pointer. One company has one permanent baseline;
replacement is refused. Identical publication retries and concurrent first
publications of the same canonical content return the committed version.
Identical upload retries reuse an unexpired prepared baseline with the current
parser version before parsing or storing another copy. Parser version `docx-3`
includes identical-style deduplication and comment-only control handling, so
preparations from older parsers are not reused. New uploads parse in a separate
internal Node action. Cleanup dispatch is independent of preparation success. Unpublished DOCX
uploads expire after 24 hours, with bounded scheduled cleanup and a recurring
recovery sweep. A daily bounded sweep removes unreferenced DOCX files left by an
interrupted preparation or export. It persists its cursor and fixed cutoff for
resumption, and advances a completed watermark to avoid rescanning retained originals.
Published originals remain until company deletion.

Published baseline blocks are stored once. Each template version references that
baseline and a complete manifest from stable rule IDs to immutable full rule
revisions. Save and Delete still publish immediately in their existing transaction;
one captured playbook, business-field validation, native document-size capacity checks, version creation, and pointer
advancement succeed or roll back together. Unchanged rule revisions are reused.
Historical versions retain deleted rules and their original payloads.

Storage accepts only required baseline/revision links and canonical manifests.
Seed imports, audits, reconciliation, and company deletion use that same model.
See [template storage](template-storage.md) and the
[fresh reset procedure](private-companies-rollout.md#fresh-development-reset).

## Bounds

| Boundary                                          | Limit                        |
| ------------------------------------------------- | ---------------------------- |
| Uploaded archive                                  | 10 MiB                       |
| Actual expanded archive / entries                 | 50 MiB / 2,000               |
| Aggregate retained XML across parsed parts        | 8 MiB                        |
| Parsed XML nodes / depth / attributes per element | 100,000 / 100 / 100          |
| Parsed XML characters across consumed parts       | 2 million                    |
| Imported blocks / serialized baseline             | 400 / 512 KiB                |
| Paragraphs / text segments / text characters      | 20,000 / 100,000 / 1 million |
| Characters per paragraph                          | 512,000                      |
| Fields / instruction characters                   | 10,000 / 4,096               |
| Table columns / rows / total cells                | 256 / 8,192 / 20,000         |
| Persisted array entries / content nesting depth   | 8,192 / 32                   |
| Individual source block / playbook business JSON  | 900,000 / 500,000 bytes      |
| Playbook rules / historical snapshot              | 4,000 / 8,000,000 bytes      |
| Upload request duration                           | 30 seconds                   |

Archive expansion is counted while inflating, and XML budgets are enforced while
parsing, before building the normalized tree. Expanded element/attribute names
are charged before constructing normalized names, so namespace expansion consumes
the same character budget. Shared source validation enforces
storage array limits; source and playbook item limits leave room for Convex wrappers.

## Verification evidence

The original `Oceans PSA Contracting Cheat Sheet 9.21.26 (2) (1).docx` imports
248 blocks with zero errors and 67 formatting warnings (66 underline warnings
and one layout warning). Discarding its comment-only controls leaves the imported
blocks identical to the conversion that reported those controls as unsupported;
the original file was unchanged. In-memory diagnostics checked identical and
attribute-reordered styles, conflicting complete definitions, missing style IDs,
strict numbering/package indexes, and accepted versus substantive or malformed
comment controls. These checks did not add repository tests or exercise live upload
and persistence.

Local verification uses `npm run verify`, backend TypeScript checking, and
`npm run seed:verify`. The existing performance suite checks saving, scheduling,
caching, immutable version behavior, and publication rollback. Seed verification
checks all business records, edit/save preservation, 58 effective/redline output
states, token/fragment provenance, and server source against the independent
historical oracle. These checks exercise canonical numbering and reference patterns.

The parser enforces the documented budgets during parsing, including expanded XML
names. Adversarial heap/memory bounds have not been remeasured after this cleanup.
The development database was reset, the strict baseline/revision schema deployed,
and the Oceans template reseeded with 113 blocks and 56 rules during the server split.
Live Clerk JWT authentication, HTTP upload/cancellation, multi-admin races,
third-party Word formats, and visual pagination remain unverified.
No repository tests or browser harness were added.
