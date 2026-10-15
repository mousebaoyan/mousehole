-- A 保研定位 thread being written (design §8.14): the background it asks for and the schools, as
-- the composer has them.
ALTER TABLE drafts DROP CONSTRAINT drafts_kind_check;
ALTER TABLE drafts ADD CONSTRAINT drafts_kind_check
  CHECK (kind IN ('discussion', 'question', 'poll', 'lottery', 'positioning'));
ALTER TABLE drafts ADD COLUMN positioning jsonb;
