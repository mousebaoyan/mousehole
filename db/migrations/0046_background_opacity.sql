-- How strongly one's background shows under their card and page (design §8.16), in percent.
ALTER TABLE users
  ADD COLUMN background_opacity smallint NOT NULL DEFAULT 40
    CHECK (background_opacity BETWEEN 20 AND 100);
