# Template terminology cutover

A **template** is the company's reusable setup: an uploaded source document and its instructions/concessions. A **contract** is a buyer-specific document captured from a template version. **Document** names the shared renderer, source model, formatting, import and export machinery.

Canonical storage uses `templateSources`, `templateSourceChunks`, `templateSourceCertificates` and `templateSourceValidationChunks`. Company pointers, captured template versions and authoring migration records use `templateSourceId`. Buyer contract IDs, template version IDs, item/revision IDs, frozen history, source fingerprints and storage file IDs stay unchanged. Copied source/chunk/certificate rows receive new table IDs; all references and native byte accounting are updated together through the cutover. Sources keep their business timestamps; their native `_creationTime` records the copy.

The template editor lives at `/template`. `/admin` redirects to it, preserving query parameters. New uploads use `/templates/upload`. Existing `baselineUploads` scheduled callbacks only ask the canonical expiration sweeper to run; no normal application code uses that module. The sweeper resumes after the cutover and handles expired prepared/deleting sources. Word style IDs and numbering namespaces remain stable for existing exported documents.

## Deployment sequence

Do not deploy the strict renamed schema directly to populated legacy storage. Finish any older readability/paragraph conversion and drain company deletion cleanup using the existing legacy worker first. Use a maintenance window and stop other migration/seed operators and automatic deploy watchers. A full database and file-storage export plus the exact pre-cutover application code are the rollback pair. Rehearse the sequence on a snapshot-seeded development deployment before production.

1. Identify the exact deployment and verify `CONVEX_DEPLOYMENT`, `PUBLIC_CONVEX_URL` and any deployment key agree. Announce the target before every deployment/database command. Production export, migration and deployment each require explicit approval for that action and target.

   Under the exact legacy bundle, let the existing company-deletion worker finish every `companyDeletions` marker with `status: 'cleaning'`. Verify none remain before deploying maintenance. A completed tombstone does not block cutover. Cleanup can leave sources partially drained or company pointers awaiting removal, so checking source state alone is insufficient.

2. Export the target with file storage, using an unused path. For an explicitly selected development target:

   ```sh
   npx convex export --deployment EXACT_DEV_NAME --include-file-storage --path /absolute/path/before-template-terminology.zip
   ```

3. Prepare the maintenance schema locally:

   ```sh
   node scripts/terminology-transition.mjs prepare
   ```

   This saves the canonical schema beside it and adds temporary legacy tables, mappings and durable progress. Only this schema disables native schema admission. Migration writes still validate against the canonical table validators. The temporary schema pauses authenticated app access, buyer links, cleanup/storage deletion and cron registration. Company deletion cleanup must already be drained. Previously scheduled cleanup may fail while maintenance is active; reconciliation and expiration sweeps resume remaining work after normal operation returns.

4. Deploy this reviewed maintenance bundle to the explicit target. On personal dev, after checking `.env.local`, use `npx convex dev --once`. This step publishes all current backend code, so review the full workspace first. Do not publish the frontend yet.
5. Run the bounded operator against that same personal dev deployment:

   ```sh
   node scripts/migrate-template-terminology.mjs --deployment EXACT_DEV_NAME
   ```

   The script refuses production and mismatched targets. It calls only `terminologyMigration:step`, never deploys and never retries a failed request automatically. Each transaction handles one native row and commits its cursor with its writes. On interruption, inspect the failure and rerun the same command to resume. Production execution requires a separately approved operator calling the same internal mutation on the explicitly selected production deployment until it returns `done: true`.

   Before creating migration progress or copying any data, the first step checks for a cleaning company-deletion marker. If found, it refuses with the marker ID and cleanup phase and makes zero migration writes. Maintenance keeps destructive cleanup paused after this check, so it cannot partially drain sources during migration. To recover from this entry refusal, redeploy the exact legacy bundle, finish cleanup with its existing worker, verify no cleaning markers remain, then redeploy maintenance and retry. This return to the legacy bundle is safe only before migration progress or other migration writes exist.

   Phases copy sources and chunks, remap validation certificates, replace source references in existing versions/companies/authoring jobs, and rename the company-deletion phase. Source fingerprints/order/counts, certificate chunk ownership/order/byte accounting and historical version read capacity are verified before any legacy table is drained. Deleting uploads retain their remaining chunks without requiring an already partially drained certificate. Only after verification are old rows and temporary mapping/progress rows removed. No buyer contract or captured business revision is rewritten.

6. Only after the operator returns `complete`, restore the strict schema locally:

   ```sh
   node scripts/terminology-transition.mjs restore
   ```

   Deploy the restored strict bundle to the same target. Native schema validation must succeed before publishing the frontend or reopening traffic. Regenerate bindings against the canonical schema. Do not commit either temporary schema state or `terminologyCanonicalSchema.ts`.

7. Publish the matching frontend, reload open clients, and check template setup/instructions, existing buyer contracts, contract creation, exports and `/admin` redirects. Automatic checks cover local types/build and the existing performance/lifecycle suites; the live copy, native validation, storage recovery and browser flows require this rehearsal.

If migration stops after progress or data writes have committed, leave maintenance deployed and resume from its durable phase. The safe pre-write entry refusal described above is a separate case. Do not redeploy the legacy bundle, restore the strict schema early, manually clear mappings or rerun seeding once migration writes exist. Before old rows are removed, the original source data remains available, but some parent references may already have changed; reversing just a pointer is insufficient. To abandon the cutover, restore the complete database/file snapshot with its matching pre-cutover backend/frontend under a separately reviewed recovery operation. Preserve unrelated component data and scheduled work according to the deployment's backup procedure.
