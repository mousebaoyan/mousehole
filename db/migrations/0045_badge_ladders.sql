-- Badges that come one after another as a count grows (design §8.6): which count, and how much of
-- it each takes. Written from badges/rules.ts on start, so emails can tell how far the next one is.
ALTER TABLE badges
  ADD COLUMN ladder text,
  ADD COLUMN need   integer,
  ADD CHECK ((ladder IS NULL) = (need IS NULL));
