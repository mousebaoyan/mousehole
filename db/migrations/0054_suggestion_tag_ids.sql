-- Suggested tags by ID: renamed, they still apply; deleted or merged away, they drop out. A board
-- deleted leaves the rest of the suggestion.
ALTER TABLE thread_suggestions ADD COLUMN tag_ids integer[];
UPDATE thread_suggestions s SET tag_ids = coalesce(
  (SELECT array_agg(t.id) FROM tags t WHERE t.name = ANY (s.tags)), '{}')
WHERE s.tags IS NOT NULL;
ALTER TABLE thread_suggestions DROP COLUMN tags;
ALTER TABLE thread_suggestions DROP CONSTRAINT thread_suggestions_board_id_fkey,
  ADD CONSTRAINT thread_suggestions_board_id_fkey
    FOREIGN KEY (board_id) REFERENCES boards (id) ON DELETE SET NULL;
