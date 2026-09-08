-- EPIC 7 (ST-7.2/7.3): the Admin is the sole producer of pin content in v1 (requirements §2),
-- so authoring routes need a role to check. Players are the default; promotion happens
-- out-of-band via `npm run grant-admin`, never through a player-facing endpoint.

-- Up Migration

ALTER TABLE users
    ADD COLUMN role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'admin'));

-- Down Migration

ALTER TABLE users DROP COLUMN IF EXISTS role;
