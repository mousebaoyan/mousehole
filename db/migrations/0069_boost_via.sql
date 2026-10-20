-- Where a boost came from, as for reactions: the site, a bot acting for someone, or a group it was
-- archived from (design §10.1). Of the boosts already there, those the bot left came from the
-- groups, as the plugin always names the message; the rest are taken as from the site.
ALTER TABLE boosts
  ADD COLUMN via text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'bot', 'qq'));

UPDATE boosts b SET via = 'qq'
WHERE EXISTS (
  SELECT 1 FROM audit_logs a
  WHERE a.action = 'boost.set' AND a.token_id IS NOT NULL AND a.target_type = 'post'
    AND a.target_id = b.post_id AND a.actor_id = b.user_id
);
