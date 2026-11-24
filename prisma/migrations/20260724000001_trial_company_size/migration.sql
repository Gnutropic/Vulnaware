-- @polsia:user-owned — self-reported company size from the public trial
-- signup form. Captured best-effort: the contract treats it as optional
-- and the landing remains graceful if absent. Nullable so historical
-- rows stay valid and the field is optional in the contract. Runtime
-- applies via `prisma db push` (polsia.toml); this file records the
-- intent for rollback hygiene.

ALTER TABLE "TrialWorkspace"
    ADD COLUMN "companySize" TEXT NULL;
