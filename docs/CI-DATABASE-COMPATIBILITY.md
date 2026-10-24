# Database CI host compatibility

Run 39355743591 failed before repository tests started because MongoDB 8.0 explicitly rejected the runner kernel. Its log cites SERVER-121912. The database integration job is pinned to the supported Ubuntu 22.04 hosted runner rather than the rolling ubuntu-latest label. No MongoDB startup protection, TLS setting or OS security feature is disabled; the real four-database integration checks remain mandatory. The successful job records its host kernel.

Sources:
- https://www.mongodb.com/docs/manual/administration/production-notes/
- https://jira.mongodb.org/browse/SERVER-121912

Health checks use the configured PostgreSQL role/database, an explicit MongoDB ping exit status, and MySQL TCP plus the actual fixture user's SELECT 1. The previous MySQL localhost socket ping could report healthy for its temporary initialization server before TCP became available. These changes make readiness stricter, not less strict. All credentials shown in the workflow are local disposable fixture values.
