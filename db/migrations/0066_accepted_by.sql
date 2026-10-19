-- Who accepted a floor as an answer (design §8.1). One accepted by its own author, whether the
-- asker or a moderator, marks the question solved but earns that author nothing. Those accepted
-- before are found in the audit log.
ALTER TABLE posts ADD COLUMN accepted_by integer REFERENCES users (id);

UPDATE posts p SET accepted_by = a.actor_id
FROM (
  SELECT DISTINCT ON ((data ->> 'post_id')::integer) (data ->> 'post_id')::integer AS post_id, actor_id
  FROM audit_logs WHERE action = 'thread.solve'
  ORDER BY (data ->> 'post_id')::integer, id DESC
) a
WHERE p.id = a.post_id AND p.accepted_at IS NOT NULL;

ALTER TABLE posts ADD CONSTRAINT posts_accepted_by CHECK ((accepted_at IS NULL) = (accepted_by IS NULL));
