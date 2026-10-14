-- One's own signature and avatar over the QQ ones (design §6.1). A NULL custom_bio follows the
-- QQ signature, which the bot pushes as qq_bio; avatar_custom stops the daily QQ refresh.
ALTER TABLE users RENAME COLUMN bio TO custom_bio;
ALTER TABLE users ALTER COLUMN custom_bio DROP NOT NULL, ALTER COLUMN custom_bio DROP DEFAULT;
UPDATE users SET custom_bio = NULL WHERE custom_bio = '';
ALTER TABLE users
  ADD COLUMN qq_bio text NOT NULL DEFAULT '',
  ADD COLUMN avatar_custom boolean NOT NULL DEFAULT false;
