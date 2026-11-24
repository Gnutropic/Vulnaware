-- @polsia:user-owned — dismiss-stamp column for the trial onboarding
-- checklist card pinned to /dashboard.
--
-- Nullable (no backfill needed): the card hides once the stamp is set OR
-- once all four onboarding steps complete, so a legacy workspace that
-- never acknowledged the card simply shows it (still useful) until either
-- condition resolves naturally. Idempotent under repeated `db push` once
-- this migration is recorded.

ALTER TABLE "TrialWorkspace"
    ADD COLUMN "onboardingChecklistDismissedAt" TIMESTAMP(3) NULL;
