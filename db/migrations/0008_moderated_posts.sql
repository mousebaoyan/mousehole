-- Content waiting for review or hidden is a sliver of all posts; the admin content page and the
-- overview's count read it from here instead of scanning every post.
CREATE INDEX posts_moderated ON posts (status, id DESC) WHERE status <> 'visible';
