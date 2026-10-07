-- How players find a trail: a short join code, shared as a link, a QR code, or typed in
-- (decision 2026-10-07). Unique, so one code can only ever open one trail. Alphabet and length
-- match server/src/services/joinCode.ts — no 0/O/1/I/L.

-- Up Migration

ALTER TABLE trails ADD COLUMN join_code TEXT UNIQUE;

-- Backfill existing trails. The subquery references the outer row so Postgres evaluates it per
-- row; an uncorrelated one could be hoisted and hand every trail the same code.
UPDATE trails
SET join_code = (
    SELECT string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
    FROM generate_series(1, 8)
    WHERE trails.id IS NOT NULL
)
WHERE join_code IS NULL;

ALTER TABLE trails ALTER COLUMN join_code SET NOT NULL;

-- Down Migration

ALTER TABLE trails DROP COLUMN IF EXISTS join_code;
