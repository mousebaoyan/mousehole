-- An L4's report on a floor by someone below them hides it until a moderator looks (design
-- §6.6); dismissing the report brings it back.
ALTER TABLE reports ADD COLUMN held boolean NOT NULL DEFAULT false;
