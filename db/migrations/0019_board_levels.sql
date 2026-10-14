-- Level thresholds on boards (design §8.1, §8.10): a members-only board may also want a level to
-- read it, and any board a level to start threads in. Moderators and admins pass both.
ALTER TABLE boards ADD COLUMN read_level smallint NOT NULL DEFAULT 0 CHECK (read_level BETWEEN 0 AND 5);
ALTER TABLE boards ADD COLUMN post_level smallint NOT NULL DEFAULT 0 CHECK (post_level BETWEEN 0 AND 5);
-- Guests read public boards whatever the level, so only members-only ones have one.
ALTER TABLE boards ADD CONSTRAINT boards_public_read CHECK (visibility = 'members' OR read_level = 0);
