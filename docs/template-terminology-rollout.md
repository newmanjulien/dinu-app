# Current template terminology

Reusable company content is a template; buyer-specific state is a contract. The strict schema uses `templateSources`, `templateSourceChunks`, `templateSourceCertificates`, and `templateSourceValidationChunks`. Pointers and frozen captures use `templateSourceId`. There is no temporary terminology schema, detector, converter, or transition runner.

The editor is `/template`, with `/admin` redirecting there; uploads use `/templates/upload`. Pending uploads are owned by `companySetupState.pendingTemplateSourceId`, and `templateSetup.expirePending` performs bounded retirement. Canonical certification and authoring repair remain available through the [authoring procedure](template-authoring-storage.md#repair-recertification-and-release-sequence).

The current release requires a fresh database and matching client; see [deployment](deployment.md). Dated work records describe earlier stages only. Local implementation performs no reset, conversion, or deployment.
