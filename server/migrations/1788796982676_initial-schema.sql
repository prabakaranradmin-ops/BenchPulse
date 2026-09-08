-- AR Quest-Trail Game — initial schema (ST-1.3).
-- Maps to docs/requirements-v1.0.md: SR-DATA-01/02 (ownership/scoping), GDR-01/06/07/08
-- (trail lifecycle), SR-PRIV-01 (retention), GDR-09 (post-publish issue reports), ST-2.6
-- (device-bound identity).
--
-- Migrations are append-only: once this file has run anywhere, change the schema by adding a
-- new migration, never by editing this one.

-- Up Migration

CREATE EXTENSION IF NOT EXISTS postgis;

-- ST-2.6: identity in v1 is anonymous and device-bound `[ASSUMED — confirm or override]`.
-- The client generates a high-entropy device key once and exchanges it for a session JWT; only
-- its hash is stored, so a database leak doesn't hand over playable identities. NULL for rows
-- created by other means (e.g. an Admin account, once the authoring tool exists).
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_key_hash TEXT UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A trail is authored content. Its pins live under *versions* (GDR-07) so an in-progress
-- player keeps playing the version they started, even if the Admin edits the trail later.
CREATE TABLE trails (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    created_by          UUID REFERENCES users(id),
    -- GDR-08: optional validity window; NULL = no expiry.
    expiry_days         INTEGER,
    current_version_id  UUID, -- FK added after trail_versions exists; set on publish
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trail_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trail_id        UUID NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
    version_number  INTEGER NOT NULL,
    published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (trail_id, version_number)
);

ALTER TABLE trails
    ADD CONSTRAINT fk_trails_current_version
    FOREIGN KEY (current_version_id) REFERENCES trail_versions(id);

-- Pins belong to a specific trail *version* (immutable once published), not the trail itself.
CREATE TABLE pins (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trail_version_id    UUID NOT NULL REFERENCES trail_versions(id) ON DELETE CASCADE,
    sequence_index      INTEGER NOT NULL,
    -- SR-GEO-02: stored as double precision; Unity client converts to local-origin offsets.
    lat                 DOUBLE PRECISION NOT NULL,
    lng                 DOUBLE PRECISION NOT NULL,
    alt                 DOUBLE PRECISION, -- optional; altitude-aware pins are out of scope for v1 (see backlog)
    geom                GEOGRAPHY(Point, 4326) GENERATED ALWAYS AS (
                            ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography
                        ) STORED,
    radius_m            DOUBLE PRECISION NOT NULL DEFAULT 10, -- SR-GEO-04: minimum; effective radius is max(radius_m, device accuracy)
    challenge_type      TEXT NOT NULL CHECK (challenge_type IN ('proximity_dwell', 'photo_confirmation', 'code_entry')),
    challenge_config    JSONB NOT NULL DEFAULT '{}', -- e.g. { "dwell_seconds": 15 } or { "code": "..." }
    UNIQUE (trail_version_id, sequence_index)
);

CREATE INDEX idx_pins_geom ON pins USING GIST (geom);

-- GDR-06: replaying a trail creates a new attempt rather than overwriting history.
CREATE TABLE trail_attempts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- SR-PRIV-02: "delete my data" removes the player's whole trail
    trail_id            UUID NOT NULL REFERENCES trails(id),
    trail_version_id    UUID NOT NULL REFERENCES trail_versions(id), -- snapshot at start (GDR-07)
    status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired')),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX idx_trail_attempts_user ON trail_attempts (user_id, trail_id);

-- SR-DATA-01: progress is always scoped by attempt, which is always scoped by user.
-- There is no query path in this schema that returns another player's progress.
CREATE TABLE pin_progress (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    attempt_id      UUID NOT NULL REFERENCES trail_attempts(id) ON DELETE CASCADE,
    pin_id          UUID NOT NULL REFERENCES pins(id),
    status          TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('locked', 'unlocked', 'completed')),
    completed_at    TIMESTAMPTZ,
    UNIQUE (attempt_id, pin_id)
);

-- SR-SEC-02 input + SR-PRIV-01 retention target. Purge/anonymize rows older than the
-- retention window with the scheduled job in src/jobs/ — see server/README.md.
CREATE TABLE location_history (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, -- SR-PRIV-02
    lat             DOUBLE PRECISION NOT NULL,
    lng             DOUBLE PRECISION NOT NULL,
    accuracy_m      DOUBLE PRECISION,
    recorded_at     TIMESTAMPTZ NOT NULL -- client-reported capture time, not server receipt time
                                          -- (SR-NET-02: offline completions are timestamped when they happened)
);

CREATE INDEX idx_location_history_user_time ON location_history (user_id, recorded_at);

-- GDR-09: lightweight "can't find this pin" report queue for the Admin dashboard.
-- A report outlives the player who filed it: SR-PRIV-02 deletion detaches the reporter
-- (SET NULL) rather than removing an issue the Admin still has to act on.
CREATE TABLE pin_reports (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pin_id              UUID NOT NULL REFERENCES pins(id),
    reported_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    note                TEXT,
    status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'resolved')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration
-- Destroys every trail and every player's progress. Exists for local resets; a production
-- rollback of the initial schema is a restore-from-backup situation, not this.

DROP TABLE IF EXISTS pin_reports;
DROP TABLE IF EXISTS location_history;
DROP TABLE IF EXISTS pin_progress;
DROP TABLE IF EXISTS trail_attempts;
DROP TABLE IF EXISTS pins;
ALTER TABLE IF EXISTS trails DROP CONSTRAINT IF EXISTS fk_trails_current_version;
DROP TABLE IF EXISTS trail_versions;
DROP TABLE IF EXISTS trails;
DROP TABLE IF EXISTS users;
-- postgis is left installed: other schemas in the same database may depend on it.
