-- Group admins now sync as forum admins (design §6.4). Syncing only re-derives members whose group
-- records change, so promote the ones already here.
WITH promoted AS (
  UPDATE users u SET role = 'admin'
  WHERE u.role = 'moderator' AND NOT u.role_locked
    AND EXISTS (
      SELECT FROM group_members m JOIN qq_groups g ON g.id = m.group_id
      WHERE m.user_id = u.id AND m.role = 'admin' AND m.left_at IS NULL AND g.enabled
    )
  RETURNING u.id
)
INSERT INTO audit_logs (action, target_type, target_id, data)
SELECT 'member.role', 'user', id, '{"from": "moderator", "to": "admin"}' FROM promoted;
