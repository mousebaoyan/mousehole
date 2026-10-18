-- Questions asked on the forum and left unanswered for a day are put up for a bounty, and those
-- answering them earn coins for it (design §8.19).
ALTER TABLE threads ADD COLUMN bounty_at timestamptz;
CREATE INDEX threads_bounty ON threads (bounty_at) WHERE bounty_at IS NOT NULL;

ALTER TABLE coin_ledger DROP CONSTRAINT coin_ledger_reason_check;
ALTER TABLE coin_ledger ADD CONSTRAINT coin_ledger_reason_check
  CHECK (reason IN ('check_in', 'liked', 'accepted', 'bounty', 'question', 'look'));
ALTER TABLE coin_ledger DROP CONSTRAINT coin_ledger_check;
ALTER TABLE coin_ledger ADD CONSTRAINT coin_ledger_check
  CHECK ((reason IN ('question', 'bounty')) = (thread_id IS NOT NULL));
DROP INDEX coin_ledger_daily;
CREATE UNIQUE INDEX coin_ledger_daily ON coin_ledger (user_id, reason, day)
  WHERE reason IN ('check_in', 'liked', 'accepted', 'bounty');
