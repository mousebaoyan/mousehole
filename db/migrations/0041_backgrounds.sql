-- The background of one's card and page (design §8.16): a preset's key, or custom for their own
-- picture, kept as two files under data/backgrounds; the version changes with each upload, so
-- their addresses can be cached for good.
ALTER TABLE users
  ADD COLUMN background text,
  ADD COLUMN background_version integer NOT NULL DEFAULT 0;
