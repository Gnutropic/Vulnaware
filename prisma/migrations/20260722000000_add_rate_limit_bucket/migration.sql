-- @polsia:user-owned — sliding-window rate-limit bucket table for /api/v1/*.
-- Stores one row per (credential, epoch-minute) pair. `key` is a SHA-256 hex
-- digest of the credential so the table never holds plaintext secrets.
-- The GC pass (src/lib/rate-limit.ts) deletes rows with windowStart older
-- than the current minute minus 2 so the table stays bounded to ~3 windows
-- per active credential.

CREATE TABLE "RateLimitBucket" (
    "key"         TEXT NOT NULL,
    "windowStart" INTEGER NOT NULL,
    "count"       INTEGER NOT NULL DEFAULT 1,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "RateLimitBucket_windowStart_idx" ON "RateLimitBucket"("windowStart");