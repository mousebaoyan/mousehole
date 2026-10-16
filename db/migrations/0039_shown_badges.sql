-- The badges someone picked for their card and page, in their order (design §8.16): NULL until
-- they pick, and the best ones show; empty to show none.
ALTER TABLE users ADD COLUMN shown_badge_ids integer[];
