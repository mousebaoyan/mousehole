-- Avatar frames (design §8.16): the one someone wears, and the event frame an event badge opens
-- for those who have it.
ALTER TABLE users ADD COLUMN frame text;
ALTER TABLE badges ADD COLUMN frame text;
