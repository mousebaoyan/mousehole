-- Which version of the renderer wrote a floor's html (design §8.2); start-up renders the floors of
-- older ones again. Those written so far came from the first.
ALTER TABLE posts ADD COLUMN render_version smallint NOT NULL DEFAULT 0;
