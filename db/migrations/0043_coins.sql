-- Coins (design §8.17): every coin in or out, and what each person has.
CREATE TABLE coin_ledger (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users (id),
  amount     integer NOT NULL CHECK (amount <> 0),
  reason     text    NOT NULL CHECK (reason IN ('check_in', 'liked', 'accepted', 'question', 'look')),
  -- The Beijing day earned for, or spent on.
  day        date    NOT NULL,
  thread_id  integer REFERENCES threads (id),
  look_kind  text,
  look_key   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((reason = 'question') = (thread_id IS NOT NULL)),
  CHECK ((reason = 'look') = (look_kind IS NOT NULL AND look_key IS NOT NULL))
);
-- What is earned comes once a day each: from the site and the groups both, or a settling run twice.
CREATE UNIQUE INDEX coin_ledger_daily ON coin_ledger (user_id, reason, day)
  WHERE reason IN ('check_in', 'liked', 'accepted');
CREATE INDEX coin_ledger_user ON coin_ledger (user_id, id DESC);
-- The leaderboards add up what was earned over a span of days.
CREATE INDEX coin_ledger_earned ON coin_ledger (day) WHERE amount > 0;

CREATE TABLE coin_balances (
  user_id integer PRIMARY KEY REFERENCES users (id),
  coins   integer NOT NULL CHECK (coins >= 0)
);

-- Those already here today came before there was a check-in: today is theirs too, or they would
-- start with nothing and couldn't ask a question until tomorrow.
WITH fresh AS (
  INSERT INTO coin_ledger (user_id, amount, reason, day)
  SELECT u.id, 2, 'check_in', (now() AT TIME ZONE 'Asia/Shanghai')::date FROM users u
  WHERE u.member_status = 'member' AND u.role NOT IN ('bot', 'owner') AND (
    EXISTS (SELECT 1 FROM user_days d
      WHERE d.user_id = u.id AND d.day = (now() AT TIME ZONE 'Asia/Shanghai')::date)
    OR EXISTS (SELECT 1 FROM group_members m WHERE m.user_id = u.id
      AND (m.last_sent_at AT TIME ZONE 'Asia/Shanghai')::date = (now() AT TIME ZONE 'Asia/Shanghai')::date))
  RETURNING user_id, amount)
INSERT INTO coin_balances (user_id, coins) SELECT user_id, amount FROM fresh;
