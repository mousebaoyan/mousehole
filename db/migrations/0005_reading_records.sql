-- Reading records: which floors each member has read, and their reading stats.

ALTER TABLE thread_users DROP COLUMN last_read_floor;
ALTER TABLE thread_users ADD COLUMN read_floors int4multirange NOT NULL DEFAULT '{}'; -- adjacent ranges merge on +
ALTER TABLE thread_users ADD COLUMN last_read_at timestamptz;
CREATE INDEX thread_users_read ON thread_users (user_id, last_read_at DESC)
  WHERE last_read_at IS NOT NULL;

ALTER TABLE users ADD COLUMN days_visited integer NOT NULL DEFAULT 0; -- Beijing days with a visit
ALTER TABLE users ADD COLUMN read_seconds integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN posts_read   integer NOT NULL DEFAULT 0;
