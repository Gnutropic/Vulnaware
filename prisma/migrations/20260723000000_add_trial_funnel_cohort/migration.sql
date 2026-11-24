-- @polsia:user-owned — cohort + experiment columns on TrialFunnelEvent.
--
-- Nullable + defaulted so pre-existing rows stay groupable under the
-- control cohort ("unknown") without a backfill. The two covering
-- indices back the admin reads in GET /api/analytics/trial that filter
-- by cohort/experiment.

ALTER TABLE "TrialFunnelEvent"
    ADD COLUMN "cohort"     TEXT DEFAULT 'control',
    ADD COLUMN "experiment" TEXT DEFAULT 'cloud_nudge_v0';

CREATE INDEX "TrialFunnelEvent_cohort_step_idx"     ON "TrialFunnelEvent"("cohort", "step");
CREATE INDEX "TrialFunnelEvent_experiment_step_idx" ON "TrialFunnelEvent"("experiment", "step");
