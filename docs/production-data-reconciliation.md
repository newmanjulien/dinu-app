# Production data reconciliation

Originally completed 2026-10-04 against the supplied full Convex export. The current seed is reconciled against the cleaned archive with **0 unexplained user-facing data mismatches**. The original restoration checks below describe that offline work; the development baseline reset is recorded separately below. Production was not contacted or modified.

The cleaned archive, not the previous seed, is authoritative for the current baseline. `data/migration/source` derives from the supplied export and has been edited; it is not a byte-for-byte original. All remaining contract text, instructions, concessions, tiers, logical keys, and exported system metadata are preserved. Its document hashes, every record's reconciliation status, and scenario names are in `data/migration/reconciliation.json`. The exact before/after field differences are in `data/migration/corrected-discrepancies.json` (`expected` is the database value; `actual` is the former seed value).

## Counts

| Logical entity / property            | Cleaned source archive | Previous seed | Restored seed |
| ------------------------------------ | ---------------------: | ------------: | ------------: |
| Contract blocks                      |                    113 |           113 |           113 |
| Clause boxes → Playbook Items        |                     56 |            56 |            56 |
| Deleted clause records               |                      0 |             0 |             0 |
| Occurrences → Triggers               |                     62 |            61 |            62 |
| Concessions                          |                     26 |            21 |            26 |
| Preferred concessions                |                     18 |            15 |            18 |
| Rare concessions                     |                      8 |             6 |             8 |
| Replacement rules → Contract Changes |                     66 |            55 |            66 |
| Concession after-notes               |                      6 |             0 |             6 |
| Nonempty concession detail entries   |                      1 |             0 |             1 |
| Text atoms with emphasis marks       |                     49 |             0 |            49 |
| Baseline reference atoms             |                     31 |            31 |            31 |
| Replacement reference atoms          |                      1 |             1 |             1 |

The 113 blocks comprise 17 headings, 93 paragraphs, and 3 tables. All 56 records retain all five instruction strings, including empty strings. All 26 concessions retain their detail arrays (25 empty, one with one entry). There are 14 items with concessions and 42 without. Seven items have multiple concessions. Four items have multiple triggers (2, 2, 2, and 4). Two triggers are empty insertion slots; one is in a table. Five changes address the table slot. One change activates an optional numbered paragraph. The largest concession has 11 changes.

All **766 source user-facing text values** are accounted for: 280 instruction strings, 386 baseline text atoms, 67 replacement text atoms, 26 concession descriptions, 6 after-notes, and 1 detail entry. Empty strings, punctuation, Unicode characters, whitespace, and line breaks are preserved in stored data. The extra empty coordinate anchors introduced by the refactor carry no invented copy.

## Tables, shapes, and relationships

The export contains `contractBlocks` (113), `clauseBoxes` (56), and `deletedClauseBoxes` (0). `_tables` contains three table metadata records, not additional business records. No storage, user, selection, or other application tables appear in this export. `data/migration/source-inventory.json` enumerates every observed nested field, type, and occurrence count.

- `contractBlocks`: `_id`, `_creationTime`, `blockKey`, `kind`, `order`; optional `numbering`; headings have `anchor`, `level`, `content`; paragraphs have `content`; tables have `headerRowCount`, `rows`, and optional `variant`. Numbering has `itemKey`, `sequenceKey`, `style`, optional `parentItemKey`, and one `activationProvisionKey`.
- Old content is an ordered array of segments. Each has `content` and optional `clauseKey`, `occurrenceKey`, and `provisionKey`. Inline atoms are text (`text`, optional bold/italic `marks`) or references (`targetItemKey`, optional `endTargetItemKey`). Table cells use the same segment shape.
- `clauseBoxes`: `_id`, `_creationTime`, `clauseKey`, `summary`, `howToExplainToBuyers`, `commonObjections`, `negotiation`, `changesNeedEscalation`, `preferredConcessions`, `rareConcessions`. A concession has `concessionKey`, `copy` (`before`, `detail`, optional `after`), and `replacements` (`targetProvisionKey`, `content`).
- Relationships use logical string keys, not exported Convex IDs: 62 occurrences refer to 56 clause keys; 66 replacement rules refer to 56 available provision anchors (some provisions are shared by alternatives); numbering references resolve through item keys and parent/sequence keys. One baseline reference spans a start/end range. No dangling references or ambiguous change ownership were found.
- The empty deletion table has no document shapes to infer from records; its supplied generated-schema file is preserved in the source evidence.

## Mapping into the refactored architecture

| Database representation                         | Result                                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Segmented inline content                        | Flattened immutable source atoms with deterministic `sourceKey` coordinates; text and marks retained                        |
| `clauseKey` + `occurrenceKey`                   | One Playbook Item per clause; one coordinate Trigger per occurrence; original occurrence keys retained as trigger IDs       |
| `provisionKey` / `targetProvisionKey`           | Source ranges for changes, including zero-length insertion anchors; exact mapping retained in `data/migration/mapping.json` |
| `summary`, explanation, objections, negotiation | Same strings under `instructions`                                                                                           |
| `changesNeedEscalation`                         | Exact string under `instructions.changesNeedApproval`; escalation copy is not rewritten as approval copy                    |
| Preferred / rare arrays                         | One concession array with exact `tier`, preserving order within each tier                                                   |
| `concessionKey`                                 | Same value under concession `id`                                                                                            |
| `copy.before`                                   | Exact `description`                                                                                                         |
| `copy.detail`, `copy.after`                     | Optional business fields `detail` and `after`; displayed in rep and admin panels and retained by saves                      |
| Replacement inline atoms                        | Exact `replacement` atoms, retaining reference targets                                                                      |
| `numbering.activationProvisionKey`              | `optional: true` paragraph plus normal nonempty insertion; conditional numbering and subsequent references remain dynamic   |
| `marks.bold`, `marks.italic`                    | Optional validated text marks carried through composition, tokens, layout cache identity, and visible/measurement DOM spans |

Schema changes are confined to the shared validators; the existing schema and inferred TypeScript types automatically pick them up. No old segment/provision model was reintroduced into runtime persistence. New-concession authoring limits and read-only retained-concession validation remain intact. Existing larger production concessions are preserved as existing seed records, not recreated through the limited authoring flow.

## Discrepancies corrected

- Restored five absent concessions: Net 20 payment terms, Net 30 VIP terms, insurance coverage outline, prior written marketing approval, and monthly autopay after the Initial Term. These contain 10 replacement rules.
- Restored the missing renewal-term trigger and its replacement rule for `replacement-mutual-agreement`, bringing the net increase to 11 rules.
- Restored full production trigger coverage for fees, insurance, and marketing rights. Recomputed the annual-increase coordinates from the production segmentation.
- Corrected 22 instruction fields across 15 items, including escalation wording, missing objections and negotiation guidance, the cash-flow/Initial-Term distinction for monthly billing, sensitive-data guidance, and an exact whitespace discrepancy in the entire-contract summary.
- Restored four changed concession descriptions and the production replacement content/coordinates for annual increase, both replacement-professional concessions, sensitive-data responsibility, and monthly autopay.
- Restored `term-fee-payment-monthly-autopay` to **rare**; monthly billing only after the Initial Term is the separate **preferred** concession.
- Restored six after-notes, one detail entry, all 26 detail arrays, and 49 bold/italic mark objects. The 36 changed block records reflect emphasis and segmentation/anchors; concatenated baseline wording and reference targets already matched production and were not rewritten.
- Removed trimming/paragraph normalization from the shared instruction text display; preserved empty instruction strings through semantic draft serialization. Notes/details now participate in concession equality, so saves cannot silently drop them.

In total, 16 Playbook Item rows and 36 contract-block rows differ from the former seed. The detailed ledger uses concession IDs, rather than shifting array positions, to identify corrections.

## Verification results

| Check                                                                      | Result                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Every transformed block/item compared against the export                   | 169/169 records; 0 mismatches                                                                                                               |
| Counts, all scalar values, array order, enums, optional fields, references | Pass                                                                                                                                        |
| Shared Convex persisted validators and complete geometry/reference audit   | Pass                                                                                                                                        |
| Independent old provision-rule output oracle                               | 29 scenarios: baseline, all 26 concessions individually, two existing combinations; effective text/emphasis and accepted-redline text match |
| Frozen rendering fixtures                                                  | 58 effective/redline states pass; includes token/fragment conservation and server-rendered provenance                                       |
| Draft/edit/save serialization                                              | 56/56 round trips preserve exact business data                                                                                              |
| Actual existing-item mutation handler with in-memory DB adapter            | 56/56 replacement payloads preserve data; this is not a live Convex transaction test                                                        |
| Server-rendered rep panels                                                 | 56/56 contain all nonempty instruction, concession, detail, and after-note strings unchanged                                                |
| `npm run seed:reconcile`                                                   | Pass; machine-readable report written                                                                                                       |
| `npm run seed:verify`                                                      | Pass, including source reconciliation                                                                                                       |
| `npm run check`                                                            | 0 errors, 0 warnings                                                                                                                        |
| `npm run build`                                                            | Pass, including Svelte checking and Vercel adapter build; nothing deployed                                                                  |
| Edited source/script formatting                                            | Pass                                                                                                                                        |
| Repository-wide `npm run format:check`                                     | Fails on 13 pre-existing, byte-unchanged files listed below                                                                                 |
| Production and mismatched-dev seed guards                                  | Both reject before any Convex operation; `scripts/seed-convex.mjs` is byte-identical to the input                                           |
| Live development import / browser interaction / production audit           | Not run; deployment access was not used                                                                                                     |

The 13 existing formatting failures are `src/convex/_generated/ai/ai-files.state.json`, `src/convex/_generated/ai/guidelines.md`, `src/convex/_generated/api.d.ts`, `src/convex/_generated/api.js`, `src/convex/_generated/dataModel.d.ts`, `src/convex/_generated/server.d.ts`, `src/convex/_generated/server.js`, `src/convex/tsconfig.json`, `src/lib/components/document/ContractViewer.svelte`, `src/lib/components/ui/modal/help-content.ts`, `src/lib/document/annotation-registry.ts`, `src/lib/document/runtime/source.svelte.ts`, and `src/lib/document/search/document-search.ts`.

Before refreshing fixtures, the original seed passed all 48 original states under the updated renderer. The restored seed then passed the independent old provision-rule oracle. Only after those checks were the hashes refreshed and 10 states added for the five restored concessions. Hash changes reflect the restored emphasis, source coordinates, trigger memberships, replacement rules, and effect provenance. Original hashes remain in `data/migration/prior-compositor.json`. `scripts/refresh-production-references.mjs` refuses to refresh unless source reconciliation and the independent output oracle pass; normal verification never updates hashes.

## Development rehearsal

Use a **fresh, empty development deployment**. The existing seed command intentionally refuses to overwrite differing records or restore an intentionally emptied item table. An older deployment with the old `contractBlocks` shape may reject the new schema before import.

```sh
npm ci
npm run seed:reconcile
npm run seed:verify
npm run check
npm run build
```

Configure a new development deployment with `npx convex dev`, using `.env.example` as guidance. Confirm `CONVEX_DEPLOYMENT=dev:...` and the matching `PUBLIC_CONVEX_URL`. Start the frontend, sign up, create a company, and copy its ID from the dashboard. Then:

```sh
npm run convex:seed -- --company-id COMPANY_ID
npm run db:audit -- --company-id COMPANY_ID --seed
npm run dev
```

The new `--seed` audit is read-only and compares exact business records against the local seed after aligning logical trigger identities. It excludes only Convex system IDs/timestamps and revision/operation/obsolete authoring metadata. Audit before making intentional edits. Exercise the restored concessions, preferred/rare categories, both replacement-professional triggers, the two insertion slots, after-notes/details, and saving an instruction edit without losing concession copy. Visually inspect pagination now that stored emphasis is rendered.

`npm run seed:restore-export` regenerates local seed files and the logical mapping from `data/migration/source`; it never contacts a database. For a later export, replace the source fixture with that full export, regenerate, reconcile, review the diff, and rerun validation. Unexpected tables, fields, deletion history, or unsupported occurrence layouts deliberately fail instead of being silently discarded.

## Reset and reseed

`npm run convex:seed` remains development/local-only and refuses production targets.
A frontend deployment does not load seed data. The current backend requires canonical
structured patterns and revision links; it does not transform older database records.
Follow the [fresh reset procedure](private-companies-rollout.md#fresh-development-reset),
then create the company through normal onboarding, seed its actual ID, and run the
read-only `--seed` audit before editing content.

The generator retains the supplied archive as an offline input and emits only
business fields. The scoped backend writer creates revision 1 and immutable heads;
JSONL fingerprints and prefix comparisons exclude this generated metadata. An
interrupted import resumes using the same content fingerprint and verified prefix.
The historical output oracle is self-contained offline code, rather than a second
persisted format supported by application readers.

No live reset, deployment, or seed import was performed during this cleanup.

## Exact-preservation limits and omissions

**All user-facing data in the cleaned archive is represented in the resulting seed.** The cleaned source files and mapping remain included for auditability.

Convex `_id`, `_creationTime`, and `_tables.id` are not loaded as business values. They remain in the source evidence; imports generate new document IDs/times. Legacy clause/provision keys are represented through trigger IDs, source ranges, and the explicit mapping rather than restoring old tables. The empty deleted-clause table contributes no records. `creationReceipts` is new transport infrastructure, not missing production content.

No exported relationship uses Convex document IDs, and no external-ID dependency was found in the supplied application. Dependencies in systems outside these two inputs cannot be established here; check those before cutover. Browser interaction, measured browser pagination, a live Convex authoring transaction round trip, and a production import remain rehearsal tasks. Redline presentation retains the refactor's diff algorithm; its accepted text matches production rules, but old-client visual rendering cannot be compared without the old application code.

## Every changed or added project file

| File                                                              | Why                                                                               |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `README.md`                                                       | Correct current counts; document restoration, reconciliation, and report          |
| `package.json`                                                    | Add offline restore/reconcile commands                                            |
| `data/convex/contractBlocks.jsonl`                                | Rebuild source coordinates and retain production emphasis                         |
| `data/convex/playbookItems.jsonl`                                 | Restore exact production instructions, concessions, triggers, tiers, and notes    |
| `src/convex/playbookValidators.ts`                                | Accept optional concession detail/after copy                                      |
| `src/convex/sourceValidators.ts`                                  | Accept optional bold/italic text marks                                            |
| `src/lib/playbook/draft.ts`                                       | Preserve notes, details, marks, and empty strings through semantic saves/equality |
| `src/lib/contract/model.ts`                                       | Carry marks on resolved text runs                                                 |
| `src/lib/contract/compose.ts`                                     | Preserve emphasis through source slicing/replacement and redlining                |
| `src/lib/document/pagination/prepare.ts`                          | Include emphasis in geometry cache identity                                       |
| `src/lib/components/document/SourceText.svelte`                   | Render emphasis consistently in visible and measurement spans                     |
| `src/lib/components/playbook/ConcessionRow.svelte`                | Display exact description, detail entries, and after-note                         |
| `src/lib/components/playbook/RepPlaybookPanel.svelte`             | Pass restored concession copy to display                                          |
| `src/lib/components/playbook/PlaybookEditor.svelte`               | Show retained detail/after copy in admin view                                     |
| `src/lib/components/playbook/PlaybookText.svelte`                 | Preserve displayed whitespace and line breaks                                     |
| `scripts/production-seed.mjs`                                     | Deterministic, fail-closed conversion from the full export                        |
| `scripts/reconcile-production-seed.mjs`                           | Record/output/UI/save reconciliation and machine report                           |
| `scripts/refresh-production-references.mjs`                       | Explicit reference refresh gated on independently verified restoration            |
| `scripts/verify-seed-data.mjs`                                    | Require production reconciliation and corrected counts                            |
| `scripts/verify-overlay-parity.mjs`                               | Include marks in display hashes; share canonical hashing with gated refresh       |
| `scripts/audit-convex.mjs`                                        | Add read-only `--seed` exact comparison for live rehearsal/cutover                |
| `data/reference/compositor.json`                                  | Verified restored-data hashes plus coverage for five missing concessions          |
| `data/migration/mapping.json`                                     | Old IDs/logical keys → new blocks, triggers, and provision ranges                 |
| `data/migration/reconciliation.json`                              | Complete record-level status, counts, source hashes, and verification results     |
| `data/migration/corrected-discrepancies.json`                     | Exact field-level differences from the former seed                                |
| `data/migration/source-inventory.json`                            | Complete observed shapes/types/counts for all exported tables                     |
| `data/migration/prior-compositor.json`                            | Preserve original pre-restoration hashes                                          |
| `data/migration/source/README.md`                                 | Cleaned archive documentation                                                     |
| `data/migration/source/_tables/documents.jsonl`                   | Preserved export table inventory                                                  |
| `data/migration/source/contractBlocks/documents.jsonl`            | Preserved authoritative contract records                                          |
| `data/migration/source/contractBlocks/generated_schema.jsonl`     | Preserved exported shape evidence                                                 |
| `data/migration/source/clauseBoxes/documents.jsonl`               | Cleaned authoritative clause records                                              |
| `data/migration/source/clauseBoxes/generated_schema.jsonl`        | Preserved exported shape evidence                                                 |
| `data/migration/source/deletedClauseBoxes/documents.jsonl`        | Preserved empty deletion table                                                    |
| `data/migration/source/deletedClauseBoxes/generated_schema.jsonl` | Preserved exported deletion-table shape evidence                                  |
| `docs/production-data-reconciliation.md`                          | This report, complete change list, and cutover instructions                       |

`src/convex/schema.ts`, generated TypeScript models, mutation implementations, and production-seeding safety code did not require edits: they consume the shared validators and semantic draft helpers. No dependencies changed. The deliverable excludes installed dependencies, generated build/cache folders, macOS metadata, and `.env.local`; configure environment values from your original secure setup or `.env.example`.

## Development baseline reset (2026-10-04)

The explicitly selected target is development `shiny-buzzard-89` at
`https://shiny-buzzard-89.convex.cloud`. A complete rollback snapshot, including
file storage, was saved outside this repository at
`/private/tmp/oceans-shiny-buzzard-89-before-reset-20261004.zip`; its ZIP integrity
and table counts were verified before clearing data. It contains 113 contract
blocks, 56 Playbook Items, and zero creation receipts.

A temporary internal reset mutation was deployed under the existing schema and
cleared all three application tables (169 records). The temporary mutation is
removed from the deployed final backend. The cleaned baseline was loaded through
the existing development-only seeder, which retains its overwrite guards. The
seeder verified exact record equality. The independent read-only seed audit found
zero business-data mismatches, and a direct read-only query confirmed 113 blocks,
56 items, 26 concessions, and zero creation receipts.

The build, Svelte checks, Convex TypeScript checks, seed verification (58 rendering
states), and reconciliation (56 edit/save round trips) passed. Manual source review
confirmed the creation and editing controls and rep/admin indicator were removed;
the remaining rare-concession and affected-part controls retain their bindings.
Browser interaction was not performed. Reload any open clients after this reset
because imported documents receive new IDs.

The reset snapshot is deliberately excluded from the cleaned working tree. Git
history is unchanged. Production is excluded from this reset.
