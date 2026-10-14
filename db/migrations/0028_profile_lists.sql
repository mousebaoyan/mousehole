-- Profile pages list what someone liked and whom they endorse (design §9), unless they keep that
-- to themselves.
ALTER TABLE users ADD COLUMN relations_public boolean NOT NULL DEFAULT true;
CREATE INDEX reactions_user ON reactions (user_id, created_at DESC);
CREATE INDEX endorsements_endorser ON endorsements (endorser_id);
