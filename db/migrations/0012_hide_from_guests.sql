-- "我的内容不给访客看" (design §8.10): guests then don't get this person's threads, floors or
-- boosts, and see little of their profile.
ALTER TABLE users ADD COLUMN hide_from_guests boolean NOT NULL DEFAULT false;
-- Guests' lists leave such people out; few do it, so this stays tiny and spares a scan of users.
CREATE INDEX users_hidden_from_guests ON users (id) WHERE hide_from_guests;
