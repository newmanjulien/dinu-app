# Version-bound discussions implementation

Historical work log. Its draft/successor and publication-based seller-export model is superseded by [the current data model](../data-model.md), [lifecycle](../lifecycle.md) and [retained rollout gates](../deployment.md#backend-ownership-conversion). This log is not a deployment or conversion certificate.

Scope: discussion reads/writes/receipts, proposal source→target acceptance, review email captures. No deployment, live migration, new tests, or browser checks. Preserve existing workspace changes.

Decisions: contractVersions owns discussion threads/messages/receipts; tokens authorize published versions only. Private draft access uses membership plus selected version/projection. Immutable anchor identity is retained; no automatic anchor remapping. New create commands validate projection content identity and revision. Exact receipts can reconcile after supersession; new writes require current draft or latest publication.

Coordination: version_backend owns schema indexes and context APIs; versionContext returns contract/reader/version/projection/contentIdentity/revision/writable. version_backend owns buyerChangeApprovals. Root owns frontend discussion consumers and transport callers.

Completed: read AGENTS.md, Convex expert skill, generated guidelines, approved plan; inspected existing discussion/proposal/review/email paths.

Next: implement validators and context authorization; source normalization vs target approved/candidate checks; scope buyer review helpers and emails; backend typecheck after API stabilization.

Validation: pending. Existing suites do not prove new multi-user/version authorization scenarios.
