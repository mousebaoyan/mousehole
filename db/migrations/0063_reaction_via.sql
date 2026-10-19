-- Where a reaction came from, as for floors: the site, a bot acting for someone, or a group it was
-- archived from (design §10.1). Of the reactions already there, those by people who hadn't logged
-- in yet can only have come from the groups; the rest are taken as from the site.
ALTER TABLE reactions
  ADD COLUMN via text NOT NULL DEFAULT 'web' CHECK (via IN ('web', 'bot', 'qq'));

UPDATE reactions r SET via = 'qq'
FROM users u
WHERE u.id = r.user_id AND (u.activated_at IS NULL OR u.activated_at > r.created_at);
