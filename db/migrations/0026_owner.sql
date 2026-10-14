-- The site owner (design §6.4) runs the system: settings, mail, groups, bot tokens and the logs.
-- Kept apart from anyone's QQ account, it has no QQ number and logs in only by a link from the
-- server's command line.
ALTER TABLE users DROP CONSTRAINT users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('user', 'moderator', 'admin', 'owner', 'bot'));
ALTER TABLE users ALTER COLUMN qq DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_qq_owner CHECK ((qq IS NULL) = (role = 'owner'));
CREATE UNIQUE INDEX users_owner ON users (role) WHERE role = 'owner';
