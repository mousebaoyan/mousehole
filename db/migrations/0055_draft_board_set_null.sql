-- A draft's board deleted leaves the rest of the draft, as one whose board is gone when it is
-- saved: only threads keep a board from being deleted.
ALTER TABLE drafts DROP CONSTRAINT drafts_board_id_fkey,
  ADD CONSTRAINT drafts_board_id_fkey FOREIGN KEY (board_id) REFERENCES boards (id) ON DELETE SET NULL;
