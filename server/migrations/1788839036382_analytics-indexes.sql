-- ST-8.3 (SR-PRIV-03): analytics aggregate by trail over a date range on `started_at`.
-- The existing index leads with user_id, which those queries never filter on.

-- Up Migration

CREATE INDEX idx_trail_attempts_trail_started ON trail_attempts (trail_id, started_at);

-- Supports the per-pin drop-off funnel, which walks progress rows attempt-first.
CREATE INDEX idx_pin_progress_attempt_status ON pin_progress (attempt_id, status);

-- Down Migration

DROP INDEX IF EXISTS idx_pin_progress_attempt_status;
DROP INDEX IF EXISTS idx_trail_attempts_trail_started;
