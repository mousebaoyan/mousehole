-- The forum has levels of its own (design §6.6); QQ group levels are no longer kept.
ALTER TABLE group_members DROP COLUMN level;
ALTER TABLE users DROP COLUMN level;
