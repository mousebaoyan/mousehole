-- Sponsorships (design §8.21): money paid into the payee's own WeChat or Alipay code, registered
-- here by whoever paid and confirmed by the payee or the owner. Amounts are in fen.
CREATE TABLE sponsorships (
  id           integer     GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      integer     NOT NULL REFERENCES users (id),
  amount       integer     NOT NULL CHECK (amount > 0),
  method       text        NOT NULL CHECK (method IN ('wechat', 'alipay')),
  status       text        NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'confirmed', 'rejected')),
  message      text,
  -- Shown on the thanks wall without a name.
  anonymous    boolean     NOT NULL DEFAULT false,
  -- When it was registered, or for one the payee added, when they say it was paid.
  paid_at      timestamptz NOT NULL DEFAULT now(),
  -- The latest confirming or turning down, with why.
  reviewer_id  integer     REFERENCES users (id),
  reviewed_at  timestamptz,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX sponsorships_pending ON sponsorships (user_id) WHERE status = 'pending';
CREATE INDEX sponsorships_status ON sponsorships (status, id);
CREATE INDEX sponsorships_user ON sponsorships (user_id, id);
